/**
 * Jewel OS - payload-bound approval queue.
 *
 * INV-1: no external side effect executes without an approval bound to the
 *        exact payload hash.
 * INV-2: editing an approved payload invalidates the approval.
 *
 * How the binding works. When a gated action is requested, Jewel computes
 * `canonicalHash({action, payload, account})`. That hash IS the approval's
 * identity. FMB approves a specific hash, not "an email". Change a recipient,
 * a single character of the body, an attachment or the sending account, and the
 * hash changes, so no approval exists for the new payload and execution stops.
 *
 * Approvals are also:
 *   - single-use     consumed on execution, so a grant cannot be replayed
 *   - expiring       stale intent is not standing authority (default 24h)
 *   - non-self-grant Jewel cannot approve its own request (FORBIDDEN)
 *   - account-bound  the exact sending account is part of the hash
 *   - revocable      FMB can revoke before consumption
 */
import { JsonTable } from './store.js';
import { canonicalJson, domainDigest, newId, shortRef, safeEqual } from './ids.js';
import { systemClock } from './clock.js';
import { ApprovalRequiredError, ValidationError, NotFoundError, PolicyError } from './errors.js';
import { EVENT } from './audit.js';
import { OWNER } from './constitution.js';

export const APPROVAL_STATE = Object.freeze({
  PENDING: 'pending',
  GRANTED: 'granted',
  DENIED: 'denied',
  EXPIRED: 'expired',
  CONSUMED: 'consumed',
  REVOKED: 'revoked',
  INVALIDATED: 'invalidated',
});

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export const APPROVAL_DOMAIN = 'JEWEL_APPROVAL_V1';

/**
 * Describe the capability an approval is granted against.
 *
 * Binding this matters: if a later build changes `email.send` from
 * gate:'email.send', risk:high to something permissive, an approval granted
 * under the old terms must not still authorise the new ones. Changing the
 * descriptor changes the binding, so the old grant simply stops matching.
 *
 * @param {{ name:string, risk:string, gate?:string|null, sideEffect?:boolean }} cap
 */
export function capabilityTag(cap) {
  if (!cap) return '';
  return `${cap.name}:${cap.risk}:${cap.gate ?? '-'}:${cap.sideEffect ? 'fx' : 'ro'}`;
}

/**
 * The canonical binding for an action. Everything that changes the real-world
 * effect must be inside it, or the binding is a lie.
 *
 * Domain-separated and length-framed (see `domainDigest`): the digest is valid
 * only as an approval binding, and component boundaries are explicit in the
 * hashed stream rather than implied by the serializer.
 *
 * @param {{ action:string, payload:object, account?:string|null,
 *           capability?:object|string|null }} req
 */
export function bindingHash({ action, payload, account = null, capability = null }) {
  const capTag = typeof capability === 'string' ? capability : capabilityTag(capability);
  return domainDigest(APPROVAL_DOMAIN, [
    ['action', action],
    ['account', account],
    ['capability', capTag],
    ['payload', canonicalJson(payload)],
  ]);
}

export class ApprovalQueue {
  /**
   * @param {{ dir:string, audit:object, clock?:import('./clock.js').Clock, ttlMs?:number }} opts
   */
  constructor({ dir, audit, clock = systemClock, ttlMs = DEFAULT_TTL_MS }) {
    this.table = new JsonTable(dir);
    this.audit = audit;
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  /**
   * Open an approval request. Idempotent per binding: re-requesting the same
   * payload returns the existing open request rather than spamming FMB.
   * @param {{ action:string, payload:object, account?:string|null, risk:string,
   *           summary:string, requestedBy?:string, correlationId?:string,
   *           effects?:string[], ttlMs?:number }} req
   */
  request(req) {
    const { action, payload, account = null, risk, summary, capability = null } = req;
    if (!action || typeof action !== 'string') throw new ValidationError('action is required');
    if (!summary || typeof summary !== 'string') throw new ValidationError('summary is required');

    const binding = bindingHash({ action, payload, account, capability });

    const open = this.table.list((r) => r.binding === binding && r.state === APPROVAL_STATE.PENDING);
    for (const existing of open) {
      if (!this._isExpired(existing)) return existing;
      this._transition(existing, APPROVAL_STATE.EXPIRED, 'ttl-elapsed');
    }

    const now = this.clock.ms();
    const record = {
      id: newId('apr'),
      version: 0,
      ref: shortRef(binding),
      binding,
      action,
      account,
      capability: typeof capability === 'string' ? capability : capabilityTag(capability),
      risk,
      summary,
      effects: req.effects ?? [],
      payload,
      state: APPROVAL_STATE.PENDING,
      requestedBy: req.requestedBy ?? 'jewel',
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (req.ttlMs ?? this.ttlMs)).toISOString(),
      correlationId: req.correlationId ?? null,
      decidedBy: null,
      decidedAt: null,
      consumedAt: null,
      executionId: null,
      history: [{ at: new Date(now).toISOString(), state: APPROVAL_STATE.PENDING, by: req.requestedBy ?? 'jewel' }],
    };

    this.table.put(record.id, record);
    this.audit.write(EVENT.APPROVAL_REQUESTED, {
      approvalId: record.id, ref: record.ref, action, risk, summary, binding, account, effects: record.effects,
    }, { correlationId: record.correlationId, subject: action, outcome: 'pending' });
    return record;
  }

  /**
   * Grant an approval. `by` must be the owner and must not be Jewel itself.
   * @param {string} id
   * @param {{ by:string, note?:string }} decision
   */
  grant(id, { by, note = null }) {
    const record = this._load(id);
    this._assertOwner(by, record);
    this._assertPending(record);
    const next = this._transition(record, APPROVAL_STATE.GRANTED, note, by);
    this.audit.write(EVENT.APPROVAL_GRANTED, {
      approvalId: id, ref: record.ref, action: record.action, binding: record.binding, note,
    }, { actor: by, correlationId: record.correlationId, subject: record.action, outcome: 'granted' });
    return next;
  }

  /** @param {string} id */
  deny(id, { by, reason = null }) {
    const record = this._load(id);
    this._assertOwner(by, record);
    this._assertPending(record);
    const next = this._transition(record, APPROVAL_STATE.DENIED, reason, by);
    this.audit.write(EVENT.APPROVAL_DENIED, {
      approvalId: id, ref: record.ref, action: record.action, reason,
    }, { actor: by, correlationId: record.correlationId, subject: record.action, outcome: 'denied' });
    return next;
  }

  /** Withdraw a grant before it is consumed. */
  revoke(id, { by, reason = null }) {
    const record = this._load(id);
    this._assertOwner(by, record);
    if (record.state === APPROVAL_STATE.CONSUMED) {
      throw new PolicyError('This approval was already executed and cannot be revoked.', { id, ref: record.ref });
    }
    const next = this._transition(record, APPROVAL_STATE.REVOKED, reason, by);
    this.audit.write(EVENT.APPROVAL_INVALIDATED, { approvalId: id, ref: record.ref, reason: reason ?? 'revoked' }, { actor: by, correlationId: record.correlationId, outcome: 'revoked' });
    return next;
  }

  /**
   * The enforcement point. Returns a granted, unexpired, unconsumed approval
   * whose binding matches this exact payload - or throws.
   *
   * This is the function INV-1 and INV-2 live in.
   * @param {{ action:string, payload:object, account?:string|null, capability?:object|string|null }} req
   */
  requireGrant(req) {
    const binding = bindingHash(req);
    const candidates = this.table.list((r) => r.binding === binding);

    const granted = candidates.find((r) => r.state === APPROVAL_STATE.GRANTED && !this._isExpired(r));
    if (granted) return granted;

    for (const stale of candidates.filter((r) => r.state === APPROVAL_STATE.GRANTED && this._isExpired(r))) {
      this._transition(stale, APPROVAL_STATE.EXPIRED, 'ttl-elapsed');
      this.audit.write(EVENT.APPROVAL_EXPIRED, { approvalId: stale.id, ref: stale.ref }, { correlationId: stale.correlationId, outcome: 'expired' });
    }

    const consumed = candidates.find((r) => r.state === APPROVAL_STATE.CONSUMED);
    if (consumed) {
      throw new ApprovalRequiredError(
        'That approval was already used. A repeat of the same action needs a fresh approval.',
        { reason: 'already-consumed', ref: consumed.ref, action: req.action },
      );
    }

    const denied = candidates.find((r) => r.state === APPROVAL_STATE.DENIED || r.state === APPROVAL_STATE.REVOKED);
    if (denied) {
      throw new ApprovalRequiredError(
        `FMB ${denied.state} this action.`,
        { reason: denied.state, ref: denied.ref, action: req.action },
      );
    }

    throw new ApprovalRequiredError(
      `"${req.action}" needs FMB's approval before it can run.`,
      { reason: 'no-matching-grant', binding, action: req.action },
    );
  }

  /**
   * Consume a grant at the moment of execution. Single-use by construction.
   * @param {string} id
   * @param {string} executionId
   */
  consume(id, executionId) {
    const record = this._load(id);
    if (record.state !== APPROVAL_STATE.GRANTED) {
      throw new PolicyError(`Approval is ${record.state}, not granted.`, { id, state: record.state });
    }
    if (this._isExpired(record)) {
      this._transition(record, APPROVAL_STATE.EXPIRED, 'ttl-elapsed');
      throw new ApprovalRequiredError('Approval expired before execution.', { id, ref: record.ref });
    }
    const next = this._transition(record, APPROVAL_STATE.CONSUMED, `execution:${executionId}`);
    next.consumedAt = this.clock.iso();
    next.executionId = executionId;
    this.table.put(next.id, next);
    return next;
  }

  /**
   * Called when a payload is edited: every open approval for the OLD binding
   * is invalidated explicitly, so a stale grant can never be reused.
   */
  invalidateBinding(binding, reason = 'payload-edited') {
    const affected = this.table.list((r) => r.binding === binding && (r.state === APPROVAL_STATE.PENDING || r.state === APPROVAL_STATE.GRANTED));
    for (const record of affected) {
      this._transition(record, APPROVAL_STATE.INVALIDATED, reason);
      this.audit.write(EVENT.APPROVAL_INVALIDATED, { approvalId: record.id, ref: record.ref, reason }, { correlationId: record.correlationId, outcome: 'invalidated' });
    }
    return affected.length;
  }

  /** @param {string} [state] */
  list(state) {
    const all = this.table.list();
    for (const r of all) {
      if ((r.state === APPROVAL_STATE.PENDING || r.state === APPROVAL_STATE.GRANTED) && this._isExpired(r)) {
        this._transition(r, APPROVAL_STATE.EXPIRED, 'ttl-elapsed');
      }
    }
    const refreshed = this.table.list();
    return (state ? refreshed.filter((r) => r.state === state) : refreshed)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  pending() { return this.list(APPROVAL_STATE.PENDING); }

  get(id) { return this._load(id); }

  /** Resolve by full id or short human ref (what FMB actually types). */
  resolve(idOrRef) {
    const direct = this.table.find(idOrRef);
    if (direct) return direct;
    const wanted = String(idOrRef).toUpperCase();
    const match = this.table.list((r) => safeEqual(r.ref, wanted));
    if (match.length === 1) return match[0];
    if (match.length > 1) throw new ValidationError('Ambiguous approval reference', { ref: idOrRef });
    throw new NotFoundError('No such approval', { ref: idOrRef });
  }

  // --- internals ---------------------------------------------------------

  _load(id) {
    const record = this.table.find(id);
    if (!record) throw new NotFoundError('No such approval', { id });
    return record;
  }

  _isExpired(record) {
    return this.clock.ms() > Date.parse(record.expiresAt);
  }

  _assertPending(record) {
    if (this._isExpired(record)) {
      this._transition(record, APPROVAL_STATE.EXPIRED, 'ttl-elapsed');
      throw new ApprovalRequiredError('That approval request expired. Ask Jewel to raise it again.', { id: record.id, ref: record.ref });
    }
    if (record.state !== APPROVAL_STATE.PENDING) {
      throw new PolicyError(`Approval is already ${record.state}.`, { id: record.id, state: record.state });
    }
  }

  /** Jewel may never approve its own request (constitution FORBIDDEN). */
  _assertOwner(by, record) {
    if (!by || typeof by !== 'string') throw new ValidationError('Approver identity is required');
    const actor = by.trim();
    if (actor.toLowerCase() === 'jewel' || actor.toLowerCase() === 'system' || actor === record.requestedBy) {
      throw new PolicyError('Jewel cannot approve her own request. Only FMB can approve.', { attemptedBy: actor });
    }
    if (actor.toUpperCase() !== OWNER.handle.toUpperCase()) {
      throw new PolicyError(`Only ${OWNER.handle} can approve this action.`, { attemptedBy: actor });
    }
  }

  _transition(record, state, note = null, by = null) {
    const next = structuredClone(record);
    next.state = state;
    next.decidedAt = this.clock.iso();
    if (by) next.decidedBy = by;
    next.history = [...(next.history ?? []), { at: next.decidedAt, state, by: by ?? 'system', note }];
    next.version = (next.version ?? 0) + 1;
    this.table.put(next.id, next);
    return next;
  }
}
