import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor } from '../src/core/agent/executor.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { PolicyEngine, MODE } from '../src/core/policy.js';
import { ApprovalQueue } from '../src/core/approvals.js';
import { IdempotencyLedger } from '../src/core/idempotency.js';
import { AuditLog } from '../src/core/audit.js';
import { RISK } from '../src/core/constitution.js';
import { fixedClock } from '../src/core/clock.js';
import { object, str, arr } from '../src/core/schema.js';

const PRINCIPAL = { authenticated: true, id: 'FMB', isOwner: true, scopes: ['email'], accounts: ['fmb@example.com'] };

function harness({ mode = MODE.LIVE, seal = { ok: true, signed: true }, sends = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-exec-'));
  const clock = fixedClock('2026-01-01T00:00:00Z');
  const audit = new AuditLog(join(dir, 'audit.jsonl'), { clock });
  const approvals = new ApprovalQueue({ dir: join(dir, 'approvals'), audit, clock });
  const ledger = new IdempotencyLedger({ dir: join(dir, 'idem'), audit, clock });
  const policy = new PolicyEngine({ audit, mode });

  const registry = new ToolRegistry()
    .register({
      name: 'memory.peek', description: 'Read-only probe.', risk: RISK.NONE,
      input: object({ q: str() }), run: async ({ q }) => ({ echo: q }),
    })
    .register({
      name: 'mail.send', description: 'Send an email.', risk: RISK.HIGH, gate: 'email.send', sideEffect: true,
      scope: 'email', accountOf: (a) => a.from,
      input: object({ from: str({ format: 'email' }), to: arr(str({ format: 'email' })), subject: str(), body: str() }),
      summarize: (a) => `Email "${a.subject}" to ${a.to.join(', ')}`,
      run: async (a) => { sends.push(a); return { messageId: `m${sends.length}` }; },
      simulate: async (a) => ({ simulated: true, to: a.to }),
    })
    .register({
      name: 'flaky.write', description: 'Always fails.', risk: RISK.MEDIUM, sideEffect: true, gate: null,
      input: object({}), run: async () => { throw new Error('provider exploded'); },
    })
    .register({
      name: 'half.write', description: 'Partially succeeds.', risk: RISK.MEDIUM, sideEffect: true,
      input: object({}), run: async () => ({ __partial: true, sent: 1, failed: 2 }),
    })
    .register({
      name: 'danger.dump', description: 'Forbidden.', risk: RISK.LOW, forbidden: 'secret.exfiltrate',
      input: object({}), run: async () => 'secrets',
    })
    .register({
      name: 'hang.forever', description: 'Never resolves.', risk: RISK.NONE,
      input: object({}), run: () => new Promise(() => {}),
    })
    .register({
      name: 'system.health', description: 'Diagnostic probe.', risk: RISK.NONE, diagnostic: true,
      input: object({}), run: async () => ({ ok: true }),
    })
    .freeze();

  return { exec: new Executor({ registry, policy, approvals, ledger, audit, seal, mode, clock }), approvals, audit, ledger, sends, clock };
}

const EMAIL = { from: 'fmb@example.com', to: ['client@example.com'], subject: 'Timeline', body: 'Oct 14 works.' };

test('read-only tool runs immediately', async () => {
  const { exec } = harness();
  const r = await exec.call('memory.peek', { q: 'hi' }, { principal: PRINCIPAL });
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(r.result, { echo: 'hi' });
});

test('INV-1: a gated tool does not run without approval', async () => {
  const { exec, sends } = harness();
  const r = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  assert.equal(r.status, 'pending_approval');
  assert.equal(sends.length, 0, 'nothing may be sent before approval');
  assert.ok(r.approval.ref);
  assert.match(r.approval.summary, /Timeline/);
});

test('approval unlocks exactly one execution', async () => {
  const { exec, approvals, sends } = harness();
  const pending = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  approvals.grant(pending.approval.id, { by: 'FMB' });

  const done = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  assert.equal(done.status, 'succeeded');
  assert.equal(sends.length, 1);

  const again = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  assert.equal(again.status, 'deduped');
  assert.equal(sends.length, 1, 'INV-5: no duplicate send');
});

test('INV-2: editing the body after approval blocks the send', async () => {
  const { exec, approvals, sends } = harness();
  const pending = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  approvals.grant(pending.approval.id, { by: 'FMB' });

  const edited = { ...EMAIL, body: 'Oct 15 works.' };
  const r = await exec.call('mail.send', edited, { principal: PRINCIPAL });
  assert.equal(r.status, 'pending_approval');
  assert.equal(sends.length, 0);
});

test('INV-6: a provider failure is failed, never succeeded', async () => {
  const { exec, audit } = harness();
  const r = await exec.call('flaky.write', {}, { principal: PRINCIPAL });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /provider exploded/);
  assert.equal(audit.read((x) => x.event === 'execution.succeeded').length, 0);
});

test('a partial provider result surfaces as partial', async () => {
  const { exec } = harness();
  const r = await exec.call('half.write', {}, { principal: PRINCIPAL });
  assert.equal(r.status, 'partial');
  assert.match(r.message, /partially/i);
});

test('dry-run simulates and never calls the real provider', async () => {
  const { exec, approvals, sends } = harness({ mode: MODE.DRYRUN });
  const pending = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  approvals.grant(pending.approval.id, { by: 'FMB' });
  const r = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  assert.equal(r.status, 'simulated');
  assert.equal(sends.length, 0);
  assert.equal(r.result.simulated, true);
});

test('forbidden capability is refused outright', async () => {
  const { exec } = harness();
  const r = await exec.call('danger.dump', {}, { principal: PRINCIPAL });
  assert.equal(r.status, 'refused');
});

test('INV-10: a broken seal blocks everything except declared diagnostics', async () => {
  const { exec } = harness({ seal: { ok: false, signed: false } });
  assert.equal((await exec.call('mail.send', EMAIL, { principal: PRINCIPAL })).status, 'denied');
  assert.equal((await exec.call('memory.peek', { q: 'x' }, { principal: PRINCIPAL })).status, 'denied');
  assert.equal((await exec.call('system.health', {}, { principal: PRINCIPAL })).status, 'succeeded');
});

test('INV-7: an unauthenticated caller is denied before the tool runs', async () => {
  const { exec, sends } = harness();
  const r = await exec.call('mail.send', EMAIL, { principal: { authenticated: false } });
  assert.equal(r.status, 'denied');
  assert.equal(sends.length, 0);
});

test('bad arguments fail closed with a typed error', async () => {
  const { exec } = harness();
  const r = await exec.call('mail.send', { ...EMAIL, to: ['not-an-email'] }, { principal: PRINCIPAL });
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'INVALID_INPUT');
});

test('an unexpected argument is rejected, not silently forwarded', async () => {
  const { exec } = harness();
  const r = await exec.call('mail.send', { ...EMAIL, bcc: ['attacker@example.com'] }, { principal: PRINCIPAL });
  assert.equal(r.status, 'failed');
  assert.match(r.error.message, /unexpected field/);
});

test('every execution leaves an unbroken audit receipt', async () => {
  const { exec, approvals, audit } = harness();
  const pending = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  approvals.grant(pending.approval.id, { by: 'FMB' });
  const done = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });

  assert.equal(audit.verifyChain().ok, true);
  const receipt = audit.receipt(done.correlationId);
  const events = receipt.steps.map((s) => s.event);
  assert.ok(events.includes('tool.call'));
  assert.ok(events.includes('policy.decision'));
  assert.ok(events.includes('execution.started'));
  assert.ok(events.includes('execution.succeeded'));
});

test('a hung tool times out rather than hanging or reporting success', async () => {
  const { exec } = harness();
  exec.timeoutMs = 25;
  const r = await exec.call('hang.forever', {}, { principal: PRINCIPAL });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /timed out/);
});

test('a completed action reports "already done" instead of re-asking FMB', async () => {
  const { exec, approvals, sends } = harness();
  const pending = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  approvals.grant(pending.approval.id, { by: 'FMB' });
  await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });

  const repeat = await exec.call('mail.send', EMAIL, { principal: PRINCIPAL });
  assert.equal(repeat.status, 'deduped');
  assert.match(repeat.message, /Already done/);
  assert.equal(sends.length, 1);
  // And no second approval was raised to clutter FMB's queue.
  assert.equal(approvals.pending().length, 0);
});
