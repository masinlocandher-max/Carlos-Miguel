import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../src/core/kernel.js';
import { createSeal, generateSealKeypair } from '../src/core/integrity.js';
import { createApi } from '../src/runtime/server.js';
import { builtinTools, TaskStore } from '../src/tools/index.js';
import { loadConfig } from '../src/runtime/config.js';
import { EchoModel } from '../src/adapters/model.js';
import { MODE } from '../src/core/policy.js';
import { SENSITIVITY } from '../src/core/memory.js';
import { fixedClock } from '../src/core/clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-api-token-0123456789';
const TEST_OWNER = generateSealKeypair();

const SIGNED_SEAL = (() => {
  const p = join(mkdtempSync(join(tmpdir(), 'jewel-srv-seal-')), 'SEAL.json');
  writeFileSync(p, JSON.stringify(createSeal(ROOT, { privateKey: TEST_OWNER.privateKey }), null, 2));
  return p;
})();

function workspace() {
  const effects = { sends: [] };
  return {
    effects,
    notion: { name: 'Notion', configured: true, async search() { return []; } },
    github: { name: 'GitHub', configured: true, async listRepos() { return []; } },
    google: {
      name: 'Google', configured: true,
      async createDraft() { return { draftId: 'd1' }; },
      async sendDraft(id) { effects.sends.push(id); return { messageId: 'm1' }; },
      async listThreads() { return []; },
    },
  };
}

/**
 * Every server test registers its close with `t.after`, so a failed assertion
 * cannot leave a listening socket behind and hang the whole run. Relying on a
 * trailing `await api.close()` only works when nothing throws.
 */
async function harness(t) {
  const ws = workspace();
  const kernel = await boot({
    root: ROOT,
    config: {
      ...loadConfig({}), dataDir: mkdtempSync(join(tmpdir(), 'jewel-srv-')),
      mode: MODE.LIVE, sealPublicKey: TEST_OWNER.publicKey, sealPath: SIGNED_SEAL, owner: 'FMB',
      accounts: ['fmb@example.com'], scopes: ['email', 'notion', 'calendar', 'drive', 'github'],
      clearance: SENSITIVITY.RESTRICTED,
    },
    model: new EchoModel({ script: [{ text: 'Understood.' }] }),
    workspace: ws,
    toolFactory: builtinTools,
    taskStoreFactory: (d) => new TaskStore(d),
    clock: fixedClock('2026-01-01T00:00:00Z'),
  });

  const api = createApi(kernel, { token: TOKEN, port: 0 });
  const { port } = await api.listen();
  if (t && typeof t.after === 'function') t.after(() => api.close());
  const base = `http://127.0.0.1:${port}`;

  const call = (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers },
  });

  return { kernel, api, base, call, ws };
}

test('refuses to start without a token rather than running open', async (t) => {
  const { kernel, api } = await harness(t);
  assert.throws(() => createApi(kernel, { token: null, port: 0 }), (e) => e.code === 'INVALID_INPUT');
});

test('every route but /health requires a valid bearer token', async (t) => {
  const { api, base, call } = await harness(t);

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
  assert.equal((await call('/status')).status, 200);

});

test('/health reveals liveness only, no private state', async (t) => {
  const { api, base } = await harness(t);
  const body = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(Object.keys(body).sort(), ['lockdown', 'ok', 'pinned', 'sealed', 'signed', 'trust']);
});

test('a foreign origin is rejected', async (t) => {
  const { api, call } = await harness(t);
  const res = await call('/status', { headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.status, 401);
});

test('/status reports seal, audit and provider state honestly', async (t) => {
  const { api, call } = await harness(t);
  const s = await (await call('/status')).json();
  assert.equal(s.seal.signed, true);
  assert.equal(s.seal.pinned, true);
  assert.equal(s.seal.trust, 'pinned');
  assert.equal(s.audit.intact, true);
  assert.ok(s.capabilities >= 20);
  assert.equal(s.providers.notion, true);
});

test('the API cannot bypass the approval gate', async (t) => {
  const { api, call, ws } = await harness(t);
  const payload = { from: 'fmb@example.com', draftId: 'd1', to: ['c@example.com'], subject: 'Hi', bodyHash: 'abc12345' };

  const res = await call('/call', { method: 'POST', body: JSON.stringify({ tool: 'email.send', args: payload }) });
  const out = await res.json();
  assert.equal(out.status, 'pending_approval');
  assert.equal(ws.effects.sends.length, 0, 'the API must not be able to send without approval');

  // Granting through the API works, and is attributed to FMB.
  const granted = await (await call('/approvals/grant', { method: 'POST', body: JSON.stringify({ ref: out.approval.ref }) })).json();
  assert.equal(granted.state, 'granted');

  const second = await (await call('/call', { method: 'POST', body: JSON.stringify({ tool: 'email.send', args: payload }) })).json();
  assert.equal(second.status, 'succeeded');
  assert.equal(ws.effects.sends.length, 1);

});

test('editing a payload after an API grant still invalidates it', async (t) => {
  const { api, call, ws } = await harness(t);
  const payload = { from: 'fmb@example.com', draftId: 'd1', to: ['c@example.com'], subject: 'Hi', bodyHash: 'abc12345' };
  const first = await (await call('/call', { method: 'POST', body: JSON.stringify({ tool: 'email.send', args: payload }) })).json();
  await call('/approvals/grant', { method: 'POST', body: JSON.stringify({ ref: first.approval.ref }) });

  const edited = { ...payload, to: ['someone-else@example.com'] };
  const out = await (await call('/call', { method: 'POST', body: JSON.stringify({ tool: 'email.send', args: edited }) })).json();
  assert.equal(out.status, 'pending_approval');
  assert.equal(ws.effects.sends.length, 0);
});

test('approval listings never expose the full payload', async (t) => {
  const { api, call } = await harness(t);
  await call('/call', { method: 'POST', body: JSON.stringify({
    tool: 'email.send',
    args: { from: 'fmb@example.com', draftId: 'd1', to: ['c@example.com'], subject: 'Secret subject', bodyHash: 'abc12345' },
  }) });
  const { approvals } = await (await call('/approvals')).json();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].payload, undefined, 'the list must not leak the payload');
  assert.ok(approvals[0].binding);
});

test('/ask runs a full turn and returns a trace', async (t) => {
  const { api, call } = await harness(t);
  const out = await (await call('/ask', { method: 'POST', body: JSON.stringify({ request: 'what is on today' }) })).json();
  assert.match(out.answer, /Understood/);
  assert.ok(out.trace.startsWith('cor_'));
});

test('typed errors map to correct status codes', async (t) => {
  const { api, call } = await harness(t);
  assert.equal((await call('/call', { method: 'POST', body: JSON.stringify({ tool: 'no.such' }) })).status, 200); // executor returns a failed result, not an HTTP error
  assert.equal((await call('/ask', { method: 'POST', body: JSON.stringify({}) })).status, 400);
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/call', { method: 'POST', body: '{not json' })).status, 400);
});

test('an oversized body is rejected', async (t) => {
  const { api, call } = await harness(t);
  const res = await call('/ask', { method: 'POST', body: JSON.stringify({ request: 'x'.repeat(300_000) }) });
  assert.equal(res.status, 400);
});
