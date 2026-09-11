import test from 'node:test';
import assert from 'node:assert/strict';
import { JewelClient, JewelApiError, JewelUnreachable, statusLabel } from './jewel.ts';

function stub(handler: (path: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace('http://test', '');
    calls.push({ path, init });
    const { status, body } = handler(path, init);
    return {
      ok: status < 400,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, client: new JewelClient({ baseUrl: 'http://test', token: 'tok', fetchImpl }) };
}

test('sends the bearer token on every authenticated call', async () => {
  const { calls, client } = stub(() => ({ status: 200, body: { approvals: [] } }));
  await client.approvals();
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer tok');
});

test('health never throws when the runtime is down', async () => {
  const client = new JewelClient({
    baseUrl: 'http://test', token: 'tok',
    fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
  });
  assert.deepEqual(await client.health(), { reachable: false });
});

test('an unreachable runtime is a distinct, actionable error', async () => {
  const client = new JewelClient({
    baseUrl: 'http://test', token: 'tok',
    fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
  });
  await assert.rejects(client.status(), (e: Error) => {
    assert.ok(e instanceof JewelUnreachable);
    assert.match(e.message, /npm run serve/);
    return true;
  });
});

test('a typed runtime error keeps its code and status', async () => {
  const { client } = stub(() => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'A valid bearer token is required.' } } }));
  await assert.rejects(client.status(), (e: JewelApiError) => e.code === 'UNAUTHENTICATED' && e.status === 401);
});

test('pending_approval is returned as a normal result, not thrown', async () => {
  const { client } = stub(() => ({
    status: 200,
    body: { status: 'pending_approval', executionId: 'e1', correlationId: 'c1', message: 'Waiting on FMB.', approval: { id: 'a1', ref: 'ABC123', summary: 'Send email', expiresAt: 'x' } },
  }));
  const out = await client.call('email.send', { to: ['a@b.com'] });
  assert.equal(out.status, 'pending_approval');
  assert.equal(out.approval?.ref, 'ABC123');
});

test('an unconfigured client reports itself instead of guessing', () => {
  assert.equal(new JewelClient({ baseUrl: 'http://test', token: '' }).configured, false);
  assert.equal(new JewelClient({ baseUrl: 'http://test', token: 'x' }).configured, true);
});

test('every execution status has calm, honest phrasing', () => {
  for (const key of ['succeeded', 'failed', 'partial', 'deduped', 'pending_approval', 'denied', 'refused', 'simulated'] as const) {
    assert.ok(statusLabel[key] && statusLabel[key].length > 2, `missing label for ${key}`);
  }
  assert.equal(statusLabel.deduped, 'Already done');
  assert.equal(statusLabel.simulated, 'Dry run only');
});
