/**
 * Jewel OS - memory vault with provenance.
 *
 * The README's knowledge requirement, made concrete: every retrieved record
 * preserves source id, source revision, retrieval time, project, sensitivity,
 * access restrictions, verification status and supersession relationships.
 *
 * Three properties matter more than storage:
 *
 *   PROVENANCE   Jewel can always answer "how do you know that?" with a source
 *                and a revision. A record with no source cannot be cited as
 *                fact - it is marked `unverified` and reported as such (INV-9).
 *
 *   SUPERSESSION Facts change. A newer record supersedes an older one rather
 *                than overwriting it, so the history stays auditable and Jewel
 *                never quotes a stale price or an old address as current.
 *
 *   REVOCATION   When a source's permission is withdrawn, every record derived
 *                from it becomes immediately unretrievable. Content is purged,
 *                the tombstone stays for audit. This is the README acceptance
 *                check "revoked source permissions ... remove inaccessible
 *                indexed content".
 *
 * Sensitivity is enforced on read, not merely labelled: a caller without the
 * matching clearance gets nothing, and the attempt is audited.
 */
import { JsonTable } from './store.js';
import { newId, canonicalHash, sha256 } from './ids.js';
import { systemClock } from './clock.js';
import { redact, containsSecret } from './redact.js';
import { EVENT } from './audit.js';
import { ValidationError, AuthorizationError, NotFoundError } from './errors.js';

export const SENSITIVITY = Object.freeze({
  PUBLIC: 'public',
  INTERNAL: 'internal',
  PRIVATE: 'private',
  RESTRICTED: 'restricted',
});

const SENSITIVITY_ORDER = Object.freeze([
  SENSITIVITY.PUBLIC, SENSITIVITY.INTERNAL, SENSITIVITY.PRIVATE, SENSITIVITY.RESTRICTED,
]);

export const VERIFICATION = Object.freeze({
  VERIFIED: 'verified',       // confirmed against the cited source
  UNVERIFIED: 'unverified',   // captured but not confirmed - never cite as fact
  CONFLICTED: 'conflicted',   // two sources disagree; both retained
  STALE: 'stale',             // superseded by a newer record
  REVOKED: 'revoked',         // source permission withdrawn; content purged
});

export const KIND = Object.freeze({
  FACT: 'fact',
  PREFERENCE: 'preference',
  DECISION: 'decision',
  PROJECT: 'project',
  CONTACT: 'contact',
  BRAND_RULE: 'brand_rule',
  DOCUMENT: 'document',
  NOTE: 'note',
  TASK: 'task',
});

/** @param {string} have @param {string} need */
export function clears(have, need) {
  return SENSITIVITY_ORDER.indexOf(have ?? SENSITIVITY.PUBLIC) >= SENSITIVITY_ORDER.indexOf(need ?? SENSITIVITY.PUBLIC);
}

export class MemoryVault {
  /** @param {{ dir:string, audit:object, clock?:import('./clock.js').Clock }} opts */
  constructor({ dir, audit, clock = systemClock }) {
    this.records = new JsonTable(`${dir}/records`);
    this.sources = new JsonTable(`${dir}/sources`);
    this.audit = audit;
    this.clock = clock;
  }

  /**
   * Register an authorized knowledge source. Retrieval is impossible from a
   * source that was never registered - there is no implicit trust.
   * @param {{ id:string, type:string, label:string, sensitivity?:string, owner?:string, scopes?:string[] }} src
   */
  registerSource(src) {
    if (!src?.id) throw new ValidationError('Source id is required');
    const record = {
      id: src.id,
      version: 0,
      type: src.type ?? 'unknown',
      label: src.label ?? src.id,
      sensitivity: src.sensitivity ?? SENSITIVITY.PRIVATE,
      owner: src.owner ?? 'FMB',
      scopes: src.scopes ?? [],
      authorized: true,
      registeredAt: this.clock.iso(),
      revokedAt: null,
      revokedReason: null,
    };
    this.sources.put(src.id, record);
    return record;
  }

  /**
   * Withdraw a source's authorization. Every derived record is purged of
   * content and tombstoned in the same operation.
   * @returns {{ source:string, purged:number }}
   */
  revokeSource(sourceId, reason = 'permission-withdrawn') {
    const src = this.sources.find(sourceId);
    if (!src) throw new NotFoundError('Unknown source', { sourceId });
    this.sources.put(sourceId, {
      ...src,
      authorized: false,
      revokedAt: this.clock.iso(),
      revokedReason: reason,
      version: (src.version ?? 0) + 1,
    });

    let purged = 0;
    for (const rec of this.records.list((r) => r.provenance?.sourceId === sourceId && r.verification !== VERIFICATION.REVOKED)) {
      this.records.put(rec.id, {
        ...rec,
        content: null,                      // content is destroyed, not hidden
        contentHash: rec.contentHash,       // hash retained for audit continuity
        verification: VERIFICATION.REVOKED,
        revokedAt: this.clock.iso(),
        revokedReason: reason,
        version: (rec.version ?? 0) + 1,
      });
      purged += 1;
    }

    this.audit.write(EVENT.MEMORY_WRITE, { op: 'revoke-source', sourceId, reason, purged }, { outcome: 'revoked' });
    return { source: sourceId, purged };
  }

  isSourceAuthorized(sourceId) {
    return this.sources.find(sourceId)?.authorized === true;
  }

  /**
   * Store a record. Refuses unregistered sources and refuses to store anything
   * that still looks like a credential after redaction.
   * @param {{ kind:string, subject:string, content:unknown, project?:string,
   *           sensitivity?:string, verification?:string, tags?:string[],
   *           supersedes?:string|null, accessRestrictions?:string[],
   *           provenance:{ sourceId:string, sourceRevision?:string, retrievedAt?:string, locator?:string } }} input
   */
  remember(input) {
    const { kind, subject, content, provenance } = input;
    if (!kind || !KIND[String(kind).toUpperCase()] && !Object.values(KIND).includes(kind)) {
      throw new ValidationError(`Unknown memory kind: ${kind}`, { kind });
    }
    if (!subject) throw new ValidationError('subject is required');
    if (!provenance?.sourceId) throw new ValidationError('provenance.sourceId is required - Jewel does not store unsourced knowledge');
    if (!this.isSourceAuthorized(provenance.sourceId)) {
      throw new AuthorizationError('Source is not registered or its authorization was revoked', { sourceId: provenance.sourceId });
    }
    if (containsSecret(content)) {
      throw new ValidationError('Refusing to store a value that looks like a credential. Secrets belong in the environment, never in memory.');
    }

    const now = this.clock.iso();
    const record = {
      id: newId('mem'),
      version: 0,
      kind,
      subject,
      content,
      contentHash: sha256(JSON.stringify(content ?? null)),
      project: input.project ?? null,
      sensitivity: input.sensitivity ?? SENSITIVITY.PRIVATE,
      verification: input.verification ?? VERIFICATION.UNVERIFIED,
      tags: input.tags ?? [],
      accessRestrictions: input.accessRestrictions ?? [],
      supersedes: input.supersedes ?? null,
      supersededBy: null,
      provenance: {
        sourceId: provenance.sourceId,
        sourceRevision: provenance.sourceRevision ?? null,
        retrievedAt: provenance.retrievedAt ?? now,
        locator: provenance.locator ?? null,
      },
      createdAt: now,
      revokedAt: null,
    };

    if (record.supersedes) {
      const prior = this.records.find(record.supersedes);
      if (prior) {
        this.records.put(prior.id, {
          ...prior,
          supersededBy: record.id,
          verification: VERIFICATION.STALE,
          version: (prior.version ?? 0) + 1,
        });
      }
    }

    this.records.put(record.id, record);
    this.audit.write(EVENT.MEMORY_WRITE, {
      op: 'remember', recordId: record.id, kind, subject,
      sourceId: provenance.sourceId, sensitivity: record.sensitivity, verification: record.verification,
    }, { outcome: 'stored' });
    return record;
  }

  /** Mark two records as disagreeing. Neither is deleted; both surface. */
  markConflict(idA, idB, note = null) {
    for (const [id, other] of [[idA, idB], [idB, idA]]) {
      const rec = this.records.get(id);
      this.records.put(id, {
        ...rec,
        verification: VERIFICATION.CONFLICTED,
        conflictsWith: [...new Set([...(rec.conflictsWith ?? []), other])],
        conflictNote: note,
        version: (rec.version ?? 0) + 1,
      });
    }
    this.audit.write(EVENT.MEMORY_WRITE, { op: 'conflict', a: idA, b: idB, note }, { outcome: 'conflicted' });
  }

  /** Promote a record to verified once confirmed against its source. */
  verify(id, { sourceRevision = null, by = 'FMB' } = {}) {
    const rec = this.records.get(id);
    const next = {
      ...rec,
      verification: VERIFICATION.VERIFIED,
      verifiedAt: this.clock.iso(),
      verifiedBy: by,
      provenance: { ...rec.provenance, sourceRevision: sourceRevision ?? rec.provenance.sourceRevision },
      version: (rec.version ?? 0) + 1,
    };
    this.records.put(id, next);
    return next;
  }

  /**
   * Retrieve. Enforces source authorization and clearance on every hit.
   * @param {{ query?:string, kind?:string, project?:string, tags?:string[],
   *           includeStale?:boolean, limit?:number }} q
   * @param {{ clearance?:string, id?:string, authenticated?:boolean }} principal
   */
  search(q = {}, principal = {}) {
    if (!principal.authenticated) {
      this.audit.write(EVENT.AUTH_DENIED, { op: 'memory.search', query: q.query ?? null }, { outcome: 'denied' });
      throw new AuthorizationError('Retrieval requires an authenticated session (INV-7)');
    }
    const clearance = principal.clearance ?? SENSITIVITY.PUBLIC;
    const needle = (q.query ?? '').toLowerCase().trim();
    const limit = q.limit ?? 20;

    const hits = [];
    let withheld = 0;

    for (const rec of this.records.list()) {
      if (rec.verification === VERIFICATION.REVOKED) continue;
      if (!this.isSourceAuthorized(rec.provenance.sourceId)) continue;   // live re-check
      if (!q.includeStale && rec.verification === VERIFICATION.STALE) continue;
      if (q.kind && rec.kind !== q.kind) continue;
      if (q.project && rec.project !== q.project) continue;
      if (q.tags?.length && !q.tags.every((t) => rec.tags.includes(t))) continue;

      if (!clears(clearance, rec.sensitivity)) { withheld += 1; continue; }

      if (needle) {
        const haystack = `${rec.subject} ${JSON.stringify(rec.content ?? '')} ${rec.tags.join(' ')}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      hits.push(rec);
    }

    hits.sort((a, b) => {
      const rank = (r) => (r.verification === VERIFICATION.VERIFIED ? 0 : r.verification === VERIFICATION.CONFLICTED ? 1 : 2);
      return rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt);
    });

    const results = hits.slice(0, limit);
    this.audit.write(EVENT.MEMORY_READ, {
      query: q.query ?? null, kind: q.kind ?? null, returned: results.length, withheld,
    }, { actor: principal.id ?? 'unknown', outcome: 'ok' });

    return {
      results,
      withheld,
      /** Explicit honesty: what Jewel may NOT cite as established fact. */
      unverified: results.filter((r) => r.verification !== VERIFICATION.VERIFIED).map((r) => r.id),
      conflicts: results.filter((r) => r.verification === VERIFICATION.CONFLICTED).map((r) => ({ id: r.id, with: r.conflictsWith })),
    };
  }

  /** Render results for a model prompt, provenance attached to every line. */
  toContext(results) {
    return results.map((r) => ({
      id: r.id,
      subject: r.subject,
      content: redact(r.content),
      kind: r.kind,
      project: r.project,
      verification: r.verification,
      source: `${r.provenance.sourceId}${r.provenance.sourceRevision ? `@${r.provenance.sourceRevision}` : ''}`,
      retrievedAt: r.provenance.retrievedAt,
      citable: r.verification === VERIFICATION.VERIFIED,
    }));
  }

  get(id) { return this.records.get(id); }

  stats() {
    const all = this.records.list();
    const by = (field) => all.reduce((acc, r) => { acc[r[field]] = (acc[r[field]] ?? 0) + 1; return acc; }, {});
    return {
      records: all.length,
      sources: this.sources.list().length,
      authorizedSources: this.sources.list((s) => s.authorized).length,
      byVerification: by('verification'),
      byKind: by('kind'),
      fingerprint: canonicalHash(all.map((r) => r.contentHash).sort()),
    };
  }
}
