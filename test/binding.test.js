/**
 * Jewel OS - hash construction.
 *
 * These test the properties the approval binding depends on. If any of them
 * fails, the approval gate is weaker than it appears, regardless of what the
 * rest of the suite says.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { domainDigest, canonicalJson, canonicalHash } from '../src/core/ids.js';
import { bindingHash, capabilityTag, APPROVAL_DOMAIN } from '../src/core/approvals.js';
import { idempotencyKey, IDEMPOTENCY_DOMAIN } from '../src/core/idempotency.js';

// --- domainDigest ----------------------------------------------------------

test('the same components under different domains never collide', () => {
  const parts = [['a', 'x'], ['b', 'y']];
  assert.notEqual(domainDigest('JEWEL_APPROVAL_V1', parts), domainDigest('JEWEL_IDEMPOTENCY_V1', parts));
  assert.notEqual(domainDigest('JEWEL_AUDIT_V1', parts), domainDigest('JEWEL_APPROVAL_V1', parts));
});

test('component boundaries cannot be shifted (the concatenation attack)', () => {
  // Plain concatenation would make these identical. Length framing must not.
  assert.notEqual(
    domainDigest('D', [['a', 'ab'], ['b', 'c']]),
    domainDigest('D', [['a', 'a'], ['b', 'bc']]),
  );
  assert.notEqual(
    domainDigest('D', [['a', 'x:1'], ['b', '']]),
    domainDigest('D', [['a', 'x'], ['b', '1']]),
  );
});

test('absent and empty are distinguishable', () => {
  assert.notEqual(domainDigest('D', [['a', null]]), domainDigest('D', [['a', '']]));
  assert.equal(domainDigest('D', [['a', null]]), domainDigest('D', [['a', undefined]]));
});

test('component order is part of the digest', () => {
  assert.notEqual(domainDigest('D', [['a', '1'], ['b', '2']]), domainDigest('D', [['b', '2'], ['a', '1']]));
});

test('the label is part of the digest, not decoration', () => {
  assert.notEqual(domainDigest('D', [['action', 'x']]), domainDigest('D', [['account', 'x']]));
});

test('the number of components is committed to', () => {
  assert.notEqual(domainDigest('D', [['a', 'x']]), domainDigest('D', [['a', 'x'], ['b', null]]));
});

test('digests are deterministic and full-length', () => {
  const d = domainDigest('D', [['a', 'x']]);
  assert.equal(d, domainDigest('D', [['a', 'x']]));
  assert.match(d, /^[0-9a-f]{64}$/);
});

// --- the approval binding --------------------------------------------------

const BASE = {
  action: 'email.send',
  account: 'fmb@example.com',
  payload: { to: ['client@example.com'], subject: 'Timeline', body: 'Oct 14.' },
  capability: { name: 'email.send', risk: 'high', gate: 'email.send', sideEffect: true },
};

test('the binding is deterministic and order-independent in the payload', () => {
  assert.equal(bindingHash(BASE), bindingHash(BASE));
  assert.equal(
    bindingHash({ ...BASE, payload: { body: 'Oct 14.', subject: 'Timeline', to: ['client@example.com'] } }),
    bindingHash(BASE),
  );
});

test('every consequential component changes the binding', () => {
  const variants = {
    action: { ...BASE, action: 'email.reply' },
    account: { ...BASE, account: 'other@example.com' },
    'account absent': { ...BASE, account: null },
    recipient: { ...BASE, payload: { ...BASE.payload, to: ['attacker@example.com'] } },
    'one character of body': { ...BASE, payload: { ...BASE.payload, body: 'Oct 15.' } },
    'added field': { ...BASE, payload: { ...BASE.payload, bcc: ['x@y.com'] } },
    'array order': { ...BASE, payload: { ...BASE.payload, to: ['b@x.com', 'a@x.com'] } },
  };
  for (const [what, variant] of Object.entries(variants)) {
    assert.notEqual(bindingHash(variant), bindingHash(BASE), `${what} did not change the binding`);
  }
});

test('the capability descriptor is bound: ungating a tool invalidates old grants', () => {
  const ungated = { ...BASE, capability: { ...BASE.capability, gate: null } };
  const downgraded = { ...BASE, capability: { ...BASE.capability, risk: 'low' } };
  assert.notEqual(bindingHash(ungated), bindingHash(BASE));
  assert.notEqual(bindingHash(downgraded), bindingHash(BASE));
});

test('capabilityTag captures exactly what must not change silently', () => {
  assert.equal(capabilityTag(BASE.capability), 'email.send:high:email.send:fx');
  assert.equal(capabilityTag({ name: 'memory.search', risk: 'low', gate: null, sideEffect: false }), 'memory.search:low:-:ro');
  assert.equal(capabilityTag(null), '');
});

test('a payload cannot impersonate another component', () => {
  // A payload field whose content mimics the framing of another component must
  // not be able to produce a colliding binding.
  const sneaky = {
    ...BASE,
    account: null,
    payload: { __framing: 'account:16\nfmb@example.com\n' },
  };
  assert.notEqual(bindingHash(sneaky), bindingHash({ ...BASE, payload: {} }));
});

test('the binding is tagged as an approval and nothing else', () => {
  const sameParts = domainDigest(APPROVAL_DOMAIN, [
    ['action', BASE.action], ['account', BASE.account],
    ['capability', capabilityTag(BASE.capability)], ['payload', canonicalJson(BASE.payload)],
  ]);
  assert.equal(sameParts, bindingHash(BASE));
  // And it is not reusable as an idempotency key.
  assert.notEqual(bindingHash(BASE), idempotencyKey({ action: BASE.action, binding: bindingHash(BASE) }));
});

test('an idempotency key is scoped and domain-tagged', () => {
  const binding = bindingHash(BASE);
  assert.notEqual(
    idempotencyKey({ action: 'a', binding, scope: null }),
    idempotencyKey({ action: 'a', binding, scope: 'daily' }),
  );
  assert.equal(IDEMPOTENCY_DOMAIN, 'JEWEL_IDEMPOTENCY_V1');
});

// --- canonical JSON, which the payload component still relies on -----------

test('canonical JSON is stable across key order and nesting', () => {
  assert.equal(canonicalHash({ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } }),
    canonicalHash({ b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }));
});

test('canonical JSON distinguishes types that look alike', () => {
  assert.notEqual(canonicalJson({ a: '1' }), canonicalJson({ a: 1 }));
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({ a: 'null' }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: '1,2' }));
});
