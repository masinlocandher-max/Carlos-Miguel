import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdempotencyLedger, idempotencyKey, OUTCOME } from '../src/core/idempotency.js';
import { NullAudit } from '../src/core/audit.js';
import { fixedClock } from '../src/core/clock.js';

function newLedger(timeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-idem-'));
  const clock = fixedClock('2026-01-01T00:00:00Z');
  return { ledger: new IdempotencyLedger({ dir, audit: new NullAudit(), clock, timeoutMs }), clock };
}

const KEY = idempotencyKey({ action: 'email.send', binding: 'abc123' });

test('first claim proceeds, repeat after success is deduped', () => {
  const { ledger } = newLedger();
  assert.equal(ledger.claim(KEY, { executionId: 'e1', action: 'email.send' }).status, 'claimed');
  ledger.settle(KEY, { executionId: 'e1', outcome: OUTCOME.SUCCEEDED, result: { messageId: 'm1' } });

  const retry = ledger.claim(KEY, { executionId: 'e2', action: 'email.send' });
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.outcome, OUTCOME.SUCCEEDED);
  assert.deepEqual(retry.result, { messageId: 'm1' });
});

test('INV-5: a retry cannot produce a second external effect', () => {
  const { ledger } = newLedger();
  let sends = 0;
  const send = () => {
    const claim = ledger.claim(KEY, { executionId: `e${sends}`, action: 'email.send' });
    if (claim.status !== 'claimed') return { deduped: true };
    sends += 1;
    ledger.settle(KEY, { executionId: `e${sends}`, outcome: OUTCOME.SUCCEEDED, result: { messageId: 'm1' } });
    return { deduped: false };
  };
  send(); send(); send();
  assert.equal(sends, 1);
});

test('a concurrent in-flight claim is refused', () => {
  const { ledger } = newLedger();
  ledger.claim(KEY, { executionId: 'e1', action: 'email.send' });
  const second = ledger.claim(KEY, { executionId: 'e2', action: 'email.send' });
  assert.equal(second.status, 'duplicate');
  assert.equal(second.inFlight, true);
});

test('an abandoned claim becomes indeterminate, never an auto-retry', () => {
  const { ledger, clock } = newLedger(1000);
  ledger.claim(KEY, { executionId: 'e1', action: 'email.send' });
  clock.advance(5000);
  const again = ledger.claim(KEY, { executionId: 'e2', action: 'email.send' });
  assert.equal(again.status, 'indeterminate');
  assert.match(again.message, /may or may not/);
  assert.equal(ledger.indeterminate().length, 1);
});

test('a failed attempt is recorded as failed, not success', () => {
  const { ledger } = newLedger();
  ledger.claim(KEY, { executionId: 'e1', action: 'email.send' });
  ledger.settle(KEY, { executionId: 'e1', outcome: OUTCOME.FAILED, error: { code: 'PROVIDER_FAILURE' } });
  const s = ledger.status(KEY);
  assert.equal(s.outcome, OUTCOME.FAILED);
});

test('distinct payloads get distinct keys', () => {
  assert.notEqual(
    idempotencyKey({ action: 'email.send', binding: 'aaa' }),
    idempotencyKey({ action: 'email.send', binding: 'bbb' }),
  );
});
