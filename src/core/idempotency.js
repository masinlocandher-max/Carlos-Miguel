/**
 * Jewel OS - idempotency ledger.
 *
 * INV-5: retries of the same approved action cannot duplicate the external
 * effect. This is the difference between an assistant that is safe to retry and
 * one that quietly sends the same email three times when a network blip occurs.
 *
 * Protocol (claim -> settle), append-only:
 *
 *   1. claim(key)  atomically reserves the key. First caller gets
 *                  {status:'claimed'} and may proceed. A concurrent or repeat
 *                  caller gets {status:'duplicate'} plus the recorded outcome.
 *   2. settle(...)  records the terminal result: succeeded | failed | partial.
 *
 * The dangerous case is a claim that never settles - the process died while the
 * provider may or may not have acted. That is deliberately NOT auto-retried.
 * It resolves to `status:'indeterminate'`, which surfaces to FMB for a human
 * decision, because silently re-sending is worse than asking.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppendLog } from './store.js';
import { canonicalHash } from './ids.js';
import { systemClock } from './clock.js';
import { EVENT } from './audit.js';

export const OUTCOME = Object.freeze({
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  PARTIAL: 'partial',
});

/** Stale claims older than this resolve to indeterminate rather than retrying. */
export const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Derive the idempotency key. Includes the approval binding so that two
 * legitimately distinct approved actions never collide, and a caller-supplied
 * scope for actions that are inherently repeatable (e.g. a daily brief).
 * @param {{ action:string, binding:string, scope?:string }} input
 */
export function idempotencyKey({ action, binding, scope = null }) {
  return canonicalHash({ action, binding, scope });
}

export class IdempotencyLedger {
  /** @param {{ dir:string, audit:object, clock?:import('./clock.js').Clock, timeoutMs?:number }} opts */
  constructor({ dir, audit, clock = systemClock, timeoutMs = CLAIM_TIMEOUT_MS }) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.log = new AppendLog(join(dir, 'ledger.jsonl'));
    this.audit = audit;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  _lockPath(key) { return join(this.dir, `${key.slice(0, 32)}.lock`); }

  /** Current state for a key, derived from the append-only log. */
  status(key) {
    const entries = this.log.readAll().filter((e) => e.key === key);
    if (!entries.length) return { status: 'new', entries: [] };
    const settled = entries.find((e) => e.phase === 'settle');
    if (settled) return { status: 'settled', outcome: settled.outcome, result: settled.result ?? null, at: settled.at, entries };
    const claim = entries.find((e) => e.phase === 'claim');
    const age = this.clock.ms() - Date.parse(claim.at);
    if (age > this.timeoutMs) return { status: 'indeterminate', claimedAt: claim.at, ageMs: age, entries };
    return { status: 'claimed', claimedAt: claim.at, executionId: claim.executionId, entries };
  }

  /**
   * Atomically reserve a key.
   * @param {string} key
   * @param {{ executionId:string, action:string, correlationId?:string }} meta
   * @returns {{ status:'claimed'|'duplicate'|'indeterminate', ...object }}
   */
  claim(key, meta) {
    const existing = this.status(key);

    if (existing.status === 'settled') {
      this.audit?.write(EVENT.EXECUTION_DEDUPED, {
        key, action: meta.action, previousOutcome: existing.outcome,
      }, { correlationId: meta.correlationId, outcome: 'deduped' });
      return { status: 'duplicate', outcome: existing.outcome, result: existing.result, settledAt: existing.at };
    }

    if (existing.status === 'indeterminate') {
      return {
        status: 'indeterminate',
        claimedAt: existing.claimedAt,
        message: 'A previous attempt started but never reported a result. The external effect may or may not have happened. FMB must confirm before retrying.',
      };
    }

    if (existing.status === 'claimed') {
      return { status: 'duplicate', inFlight: true, claimedAt: existing.claimedAt, executionId: existing.executionId };
    }

    // O_EXCL gives us mutual exclusion against concurrent processes.
    try {
      writeFileSync(this._lockPath(key), meta.executionId, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.code === 'EEXIST') {
        const holder = (() => { try { return readFileSync(this._lockPath(key), 'utf8'); } catch { return null; } })();
        if (holder && holder !== meta.executionId) {
          return { status: 'duplicate', inFlight: true, executionId: holder };
        }
      } else {
        throw err;
      }
    }

    this.log.append({
      key, phase: 'claim', at: this.clock.iso(),
      executionId: meta.executionId, action: meta.action, correlationId: meta.correlationId ?? null,
    });
    return { status: 'claimed', executionId: meta.executionId };
  }

  /**
   * Record the terminal outcome. Settling is what makes a retry safe.
   * @param {string} key
   * @param {{ executionId:string, outcome:string, result?:unknown, error?:object, correlationId?:string }} meta
   */
  settle(key, meta) {
    const entry = {
      key, phase: 'settle', at: this.clock.iso(),
      executionId: meta.executionId,
      outcome: meta.outcome,
      result: meta.result ?? null,
      error: meta.error ?? null,
      correlationId: meta.correlationId ?? null,
    };
    this.log.append(entry);
    return entry;
  }

  /** Claims that started and never finished - shown to FMB in `doctor`. */
  indeterminate() {
    const keys = new Set(this.log.readAll().map((e) => e.key));
    const out = [];
    for (const key of keys) {
      const s = this.status(key);
      if (s.status === 'indeterminate') out.push({ key, ...s, entries: undefined });
    }
    return out;
  }
}
