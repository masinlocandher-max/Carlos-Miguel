import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, EFFECT, MODE, riskAtLeast } from '../src/core/policy.js';
import { RISK } from '../src/core/constitution.js';

const OK_CTX = {
  principal: { authenticated: true, id: 'FMB', isOwner: true, scopes: ['email', 'calendar'], accounts: ['fmb@example.com'] },
  seal: { ok: true, signed: true, pinned: true, trust: 'pinned' },
  mode: MODE.LIVE,
};

test('read-only capability is allowed', () => {
  const d = decide({ name: 'memory.search', risk: RISK.NONE }, OK_CTX);
  assert.equal(d.effect, EFFECT.ALLOW);
});

test('every AGENTS.md gated action requires approval', () => {
  const gates = ['email.send', 'content.publish', 'app.deploy', 'pr.merge', 'file.delete', 'price.confirm', 'payments.add'];
  for (const gate of gates) {
    const d = decide({ name: `tool.${gate}`, risk: RISK.MEDIUM, gate, sideEffect: true }, OK_CTX);
    assert.equal(d.effect, EFFECT.APPROVE, `${gate} was not gated`);
    assert.ok(d.obligations.includes('bind-payload'));
    assert.ok(d.obligations.includes('idempotency-claim'));
  }
});

test('high risk requires approval even without an explicit gate', () => {
  const d = decide({ name: 'anything', risk: RISK.HIGH, sideEffect: true }, OK_CTX);
  assert.equal(d.effect, EFFECT.APPROVE);
});

test('critical risk demands a second confirmation', () => {
  const d = decide({ name: 'release.publish', risk: RISK.CRITICAL, gate: 'release.publish', sideEffect: true }, OK_CTX);
  assert.ok(d.obligations.includes('confirm-twice'));
});

test('forbidden actions are refused, not gated', () => {
  const d = decide({ name: 'dump.env', risk: RISK.LOW, forbidden: 'secret.exfiltrate' }, OK_CTX);
  assert.equal(d.effect, EFFECT.REFUSE);
  assert.equal(d.requiresApproval, false);
});

test('INV-7: unauthenticated retrieval is denied before any provider call', () => {
  const d = decide({ name: 'notion.search', risk: RISK.MEDIUM }, { ...OK_CTX, principal: { authenticated: false } });
  assert.equal(d.effect, EFFECT.DENY);
  assert.equal(d.reason, 'unauthenticated');
});

test('missing scope is denied', () => {
  const d = decide({ name: 'gmail.read', risk: RISK.MEDIUM, scope: 'email' },
    { ...OK_CTX, principal: { ...OK_CTX.principal, scopes: ['calendar'] } });
  assert.equal(d.reason, 'scope-missing');
});

test('authority is never inferred from an account name', () => {
  const d = decide({ name: 'gmail.send', risk: RISK.MEDIUM, gate: 'email.send', account: 'stranger@example.com', sideEffect: true }, OK_CTX);
  assert.equal(d.effect, EFFECT.DENY);
  assert.equal(d.reason, 'account-not-authorized');
});

test('INV-10: a broken seal puts Jewel in lockdown', () => {
  const d = decide({ name: 'memory.search', risk: RISK.LOW }, { ...OK_CTX, seal: { ok: false, signed: false, pinned: false, trust: 'broken' } });
  assert.equal(d.effect, EFFECT.DENY);
  assert.equal(d.reason, 'seal-broken');
});

test('only explicitly diagnostic capabilities survive a broken seal', () => {
  const broken = { ...OK_CTX, seal: { ok: false, signed: false, pinned: false, trust: 'broken' } };
  assert.equal(decide({ name: 'system.doctor', risk: RISK.NONE, diagnostic: true }, broken).effect, EFFECT.ALLOW);
  // Reading private memory is low-risk to the world and catastrophic to FMB.
  // "risk: none" must NOT be a lockdown bypass.
  assert.equal(decide({ name: 'memory.search', risk: RISK.NONE }, broken).effect, EFFECT.DENY);
});

test('an unsigned seal disables high-risk capability', () => {
  const ctx = { ...OK_CTX, seal: { ok: true, signed: false, pinned: false, trust: 'unsigned' } };
  assert.equal(decide({ name: 'gmail.send', risk: RISK.HIGH, gate: 'email.send', sideEffect: true }, ctx).reason, 'unpinned-seal');
  assert.equal(decide({ name: 'notion.search', risk: RISK.MEDIUM }, ctx).effect, EFFECT.ALLOW);
});

test('a seal signed by an UNTRUSTED key also disables high-risk capability', () => {
  // This is the attack the symmetric design could not distinguish: the core is
  // signed, just not by FMB. `signed` alone must never be enough.
  const ctx = { ...OK_CTX, seal: { ok: true, signed: true, pinned: false, trust: 'unpinned' } };
  const d = decide({ name: 'gmail.send', risk: RISK.HIGH, gate: 'email.send', sideEffect: true }, ctx);
  assert.equal(d.effect, EFFECT.DENY);
  assert.equal(d.reason, 'unpinned-seal');
  assert.match(d.message, /no way to confirm is FMB/);
});

test('dry-run adds a simulate-only obligation', () => {
  const d = decide({ name: 'gmail.send', risk: RISK.MEDIUM, gate: 'email.send', sideEffect: true }, { ...OK_CTX, mode: MODE.DRYRUN });
  assert.ok(d.obligations.includes('simulate-only'));
});

test('risk ordering', () => {
  assert.equal(riskAtLeast(RISK.HIGH, RISK.MEDIUM), true);
  assert.equal(riskAtLeast(RISK.LOW, RISK.HIGH), false);
});
