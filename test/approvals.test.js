import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalQueue, APPROVAL_STATE, bindingHash } from '../src/core/approvals.js';
import { AuditLog } from '../src/core/audit.js';
import { fixedClock } from '../src/core/clock.js';

function newQueue(ttlMs) {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-apr-'));
  const clock = fixedClock('2026-01-01T00:00:00Z');
  const audit = new AuditLog(join(dir, 'audit.jsonl'), { clock });
  return { q: new ApprovalQueue({ dir: join(dir, 'approvals'), audit, clock, ttlMs }), clock, audit };
}

const EMAIL = {
  action: 'email.send',
  account: 'fmb@example.com',
  risk: 'high',
  summary: 'Reply to client about October timeline',
  payload: { to: ['client@example.com'], subject: 'October timeline', body: 'Confirming Oct 14.' },
};

test('INV-1: unapproved action is refused', () => {
  const { q } = newQueue();
  assert.throws(() => q.requireGrant(EMAIL), (e) => e.code === 'APPROVAL_REQUIRED' && e.details.reason === 'no-matching-grant');
});

test('granted approval satisfies the exact payload', () => {
  const { q } = newQueue();
  const req = q.request(EMAIL);
  q.grant(req.id, { by: 'FMB' });
  const grant = q.requireGrant(EMAIL);
  assert.equal(grant.state, APPROVAL_STATE.GRANTED);
});

test('INV-2: editing ANY field invalidates the approval', () => {
  const edits = [
    { ...EMAIL, payload: { ...EMAIL.payload, body: 'Confirming Oct 15.' } },        // one character
    { ...EMAIL, payload: { ...EMAIL.payload, to: ['other@example.com'] } },          // recipient
    { ...EMAIL, payload: { ...EMAIL.payload, subject: 'October timeline ' } },       // whitespace
    { ...EMAIL, payload: { ...EMAIL.payload, attachments: ['contract.pdf'] } },      // added field
    { ...EMAIL, account: 'other@example.com' },                                      // sending account
  ];
  for (const edited of edits) {
    const { q } = newQueue();
    const req = q.request(EMAIL);
    q.grant(req.id, { by: 'FMB' });
    assert.throws(() => q.requireGrant(edited), (e) => e.code === 'APPROVAL_REQUIRED',
      `edit was wrongly accepted: ${JSON.stringify(edited.payload)}`);
  }
});

test('key order does not change the binding', () => {
  const a = bindingHash({ action: 'x', payload: { a: 1, b: 2 }, account: null });
  const b = bindingHash({ action: 'x', payload: { b: 2, a: 1 }, account: null });
  assert.equal(a, b);
});

test('approval is single-use: consumption blocks replay', () => {
  const { q } = newQueue();
  const req = q.request(EMAIL);
  q.grant(req.id, { by: 'FMB' });
  q.consume(q.requireGrant(EMAIL).id, 'exec_1');
  assert.throws(() => q.requireGrant(EMAIL), (e) => e.details.reason === 'already-consumed');
});

test('approvals expire', () => {
  const { q, clock } = newQueue(1000);
  const req = q.request(EMAIL);
  q.grant(req.id, { by: 'FMB' });
  clock.advance(1500);
  assert.throws(() => q.requireGrant(EMAIL), (e) => e.code === 'APPROVAL_REQUIRED');
});

test('Jewel cannot approve her own request (FORBIDDEN: approval.selfgrant)', () => {
  const { q } = newQueue();
  const req = q.request(EMAIL);
  for (const impostor of ['jewel', 'Jewel', 'system', 'JEWEL']) {
    assert.throws(() => q.grant(req.id, { by: impostor }), (e) => e.code === 'POLICY_DENIED');
  }
});

test('a non-owner cannot approve', () => {
  const { q } = newQueue();
  const req = q.request(EMAIL);
  assert.throws(() => q.grant(req.id, { by: 'someone-else' }), (e) => e.code === 'POLICY_DENIED');
});

test('denial and revocation are reported distinctly', () => {
  const { q } = newQueue();
  const denied = q.request(EMAIL);
  q.deny(denied.id, { by: 'FMB', reason: 'wrong tone' });
  assert.throws(() => q.requireGrant(EMAIL), (e) => e.details.reason === 'denied');

  const { q: q2 } = newQueue();
  const r2 = q2.request(EMAIL);
  q2.grant(r2.id, { by: 'FMB' });
  q2.revoke(r2.id, { by: 'FMB', reason: 'changed my mind' });
  assert.throws(() => q2.requireGrant(EMAIL), (e) => e.details.reason === 'revoked');
});

test('a consumed approval cannot be revoked', () => {
  const { q } = newQueue();
  const req = q.request(EMAIL);
  q.grant(req.id, { by: 'FMB' });
  q.consume(req.id, 'exec_9');
  assert.throws(() => q.revoke(req.id, { by: 'FMB' }), (e) => e.code === 'POLICY_DENIED');
});

test('repeat requests for the same payload reuse the open request', () => {
  const { q } = newQueue();
  const a = q.request(EMAIL);
  const b = q.request(EMAIL);
  assert.equal(a.id, b.id);
  assert.equal(q.pending().length, 1);
});

test('explicit invalidation clears open approvals for a binding', () => {
  const { q } = newQueue();
  const req = q.request(EMAIL);
  q.grant(req.id, { by: 'FMB' });
  const n = q.invalidateBinding(bindingHash(EMAIL), 'payload-edited');
  assert.equal(n, 1);
  assert.throws(() => q.requireGrant(EMAIL));
});

test('short ref resolves to the record and is audited', () => {
  const { q, audit } = newQueue();
  const req = q.request(EMAIL);
  assert.equal(q.resolve(req.ref).id, req.id);
  assert.ok(audit.read((r) => r.event === 'approval.requested').length === 1);
  assert.equal(audit.verifyChain().ok, true);
});
