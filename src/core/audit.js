/**
 * Jewel OS - hash-chained audit ledger.
 *
 * INV-4: every state change writes an audit record before the change is
 * observable. Each record embeds the hash of the previous record, so the log is
 * tamper-EVIDENT: altering or deleting any entry breaks every hash after it and
 * `verifyChain()` reports the exact index where the chain diverges.
 *
 * INV-8: every record passes through redaction before it is written. A secret
 * cannot enter the ledger even by accident.
 *
 * The ledger is append-only. Nothing in the runtime can rewrite or truncate it
 * (constitution FORBIDDEN: 'audit.rewrite').
 */
import { AppendLog } from './store.js';
import { canonicalHash, newId } from './ids.js';
import { redact } from './redact.js';
import { systemClock } from './clock.js';

export const GENESIS = '0'.repeat(64);

/** Event names are stable API. Add, never repurpose. */
export const EVENT = Object.freeze({
  BOOT: 'system.boot',
  SEAL_VERIFIED: 'system.seal.verified',
  SEAL_VIOLATION: 'system.seal.violation',
  TOOL_CALL: 'tool.call',
  TOOL_RESULT: 'tool.result',
  TOOL_DENIED: 'tool.denied',
  POLICY_DECISION: 'policy.decision',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_GRANTED: 'approval.granted',
  APPROVAL_DENIED: 'approval.denied',
  APPROVAL_EXPIRED: 'approval.expired',
  APPROVAL_INVALIDATED: 'approval.invalidated',
  EXECUTION_STARTED: 'execution.started',
  EXECUTION_SUCCEEDED: 'execution.succeeded',
  EXECUTION_FAILED: 'execution.failed',
  EXECUTION_PARTIAL: 'execution.partial',
  EXECUTION_DEDUPED: 'execution.deduped',
  MEMORY_WRITE: 'memory.write',
  MEMORY_READ: 'memory.read',
  INJECTION_DETECTED: 'security.injection.detected',
  AUTH_DENIED: 'security.auth.denied',
  PROVIDER_CALL: 'provider.call',
  AGENT_TURN: 'agent.turn',
  NOTE: 'note',
});

export class AuditLog {
  /**
   * @param {string} path jsonl file path
   * @param {{ clock?: import('./clock.js').Clock }} [opts]
   */
  constructor(path, opts = {}) {
    this.log = new AppendLog(path);
    this.clock = opts.clock ?? systemClock;
  }

  /** Hash of the most recent record, or GENESIS for an empty ledger. */
  head() {
    const last = this.log.last();
    return last?.hash ?? GENESIS;
  }

  get length() { return this.log.size; }

  /**
   * Append a record. Returns the written record including its chain hash.
   * @param {string} event one of EVENT
   * @param {object} [data] arbitrary payload - redacted before write
   * @param {{ actor?: string, subject?: string, correlationId?: string, outcome?: string }} [meta]
   */
  write(event, data = {}, meta = {}) {
    const prev = this.head();
    const body = {
      id: newId('aud'),
      at: this.clock.iso(),
      event,
      actor: meta.actor ?? 'jewel',
      subject: meta.subject ?? null,
      correlationId: meta.correlationId ?? null,
      outcome: meta.outcome ?? null,
      data: redact(data),
      prev,
    };
    const record = { ...body, hash: canonicalHash(body) };
    this.log.append(record);
    return record;
  }

  /** @param {(r:object)=>boolean} [predicate] */
  read(predicate) {
    const all = this.log.readAll();
    return predicate ? all.filter(predicate) : all;
  }

  /** Records sharing a correlation id, in order - the receipt for one action. */
  trace(correlationId) {
    return this.read((r) => r.correlationId === correlationId);
  }

  /**
   * Verify the whole chain.
   * @returns {{ ok:boolean, length:number, brokenAt:number|null, reason:string|null }}
   */
  verifyChain() {
    const all = this.log.readAll();
    let prev = GENESIS;
    for (let i = 0; i < all.length; i += 1) {
      const rec = all[i];
      if (rec.__corrupt) return { ok: false, length: all.length, brokenAt: i, reason: 'corrupt-record' };
      if (rec.prev !== prev) return { ok: false, length: all.length, brokenAt: i, reason: 'prev-mismatch' };
      const { hash, ...body } = rec;
      if (canonicalHash(body) !== hash) return { ok: false, length: all.length, brokenAt: i, reason: 'hash-mismatch' };
      prev = hash;
    }
    return { ok: true, length: all.length, brokenAt: null, reason: null };
  }

  /** Human-readable receipt for one correlated action. */
  receipt(correlationId) {
    const events = this.trace(correlationId);
    if (!events.length) return null;
    return {
      correlationId,
      startedAt: events[0].at,
      endedAt: events[events.length - 1].at,
      steps: events.map((e) => ({ at: e.at, event: e.event, outcome: e.outcome })),
      terminal: events[events.length - 1].event,
      chainHead: events[events.length - 1].hash,
    };
  }
}

/** A no-op audit sink for pure unit tests that must not touch disk. */
export class NullAudit {
  write(event, data = {}, meta = {}) { return { id: 'null', event, data, meta, hash: GENESIS, prev: GENESIS }; }
  head() { return GENESIS; }
  read() { return []; }
  trace() { return []; }
  receipt() { return null; }
  verifyChain() { return { ok: true, length: 0, brokenAt: null, reason: null }; }
  get length() { return 0; }
}
