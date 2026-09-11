import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { RISK } from '../src/core/constitution.js';

const ok = { name: 'demo.read', description: 'Read a demo value.', risk: RISK.NONE, run: async () => 'v' };

test('registers and retrieves a tool', () => {
  const r = new ToolRegistry().register(ok);
  assert.equal(r.get('demo.read').name, 'demo.read');
  assert.deepEqual(r.names(), ['demo.read']);
});

test('a capability cannot be shadowed', () => {
  const r = new ToolRegistry().register(ok);
  assert.throws(() => r.register({ ...ok, risk: RISK.NONE, gate: null }), (e) => e.code === 'POLICY_DENIED');
});

test('the registry is sealed after freeze', () => {
  const r = new ToolRegistry().register(ok).freeze();
  assert.throws(() => r.register({ ...ok, name: 'demo.other' }), (e) => e.code === 'POLICY_DENIED');
});

test('rejects a side-effecting tool that understates its risk', () => {
  const r = new ToolRegistry();
  assert.throws(() => r.register({ ...ok, name: 'sneaky.send', risk: RISK.LOW, sideEffect: true }),
    (e) => e.code === 'INVALID_INPUT');
});

test('rejects an unknown gate or risk tier', () => {
  const r = new ToolRegistry();
  assert.throws(() => r.register({ ...ok, name: 'x.y', gate: 'not.a.gate' }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => r.register({ ...ok, name: 'x.z', risk: 'spicy' }), (e) => e.code === 'INVALID_INPUT');
});

test('rejects malformed names and missing run', () => {
  const r = new ToolRegistry();
  assert.throws(() => r.register({ ...ok, name: 'NoDots' }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => r.register({ name: 'a.b', description: 'd', risk: RISK.NONE }), (e) => e.code === 'INVALID_INPUT');
});

test('validates and coerces arguments, rejecting unknown fields', () => {
  const r = new ToolRegistry().register({
    ...ok, name: 'demo.typed',
    input: { type: 'object', properties: { n: { type: 'integer' }, s: { type: 'string', optional: true } }, additionalProperties: false, required: ['n'] },
  });
  assert.deepEqual(r.validateArgs('demo.typed', { n: '42' }), { n: 42 });
  assert.throws(() => r.validateArgs('demo.typed', { n: 1, evil: 'x' }), (e) => /unexpected field/.test(e.message));
  assert.throws(() => r.validateArgs('demo.typed', {}), (e) => e.code === 'INVALID_INPUT');
});

test('capabilityOf carries the account the call binds to', () => {
  const r = new ToolRegistry().register({
    ...ok, name: 'mail.send', risk: RISK.HIGH, gate: 'email.send', sideEffect: true,
    accountOf: (a) => a.from ?? null,
  });
  assert.equal(r.capabilityOf('mail.send', { from: 'fmb@example.com' }).account, 'fmb@example.com');
});

test('catalogue states approval requirements honestly', () => {
  const r = new ToolRegistry()
    .register(ok)
    .register({ ...ok, name: 'mail.send', risk: RISK.HIGH, gate: 'email.send', sideEffect: true });
  const cat = r.catalogue();
  assert.equal(cat.find((c) => c.name === 'mail.send').requiresApproval, true);
  assert.equal(cat.find((c) => c.name === 'demo.read').requiresApproval, false);
  assert.equal(r.catalogue({ includeHighRisk: false }).length, 1);
});

test('unknown capability is a typed not-found', () => {
  assert.throws(() => new ToolRegistry().get('nope.nope'), (e) => e.code === 'NOT_FOUND');
});
