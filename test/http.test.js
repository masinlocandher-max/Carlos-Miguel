import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/adapters/http.js';
import { NullAudit } from '../src/core/audit.js';

function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift() ?? queue[queue.length - 1];
      if (next instanceof Error) throw next;
      return { ok: next.status < 400, status: next.status, text: async () => next.body ?? '' };
    },
  };
}

function client(stub, over = {}) {
  return new HttpClient({
    baseUrl: 'https://api.example.com', provider: 'example', audit: new NullAudit(),
    auth: { type: 'bearer', value: 'sk-TESTKEYTESTKEYTESTKEY' }, fetchImpl: stub.fetchImpl, maxRetries: 3, ...over,
  });
}

test('attaches the credential as a header, never in the URL', async () => {
  const stub = stubFetch([{ status: 200, body: '{"ok":true}' }]);
  await client(stub).get('/models');
  const { url, init } = stub.calls[0];
  assert.ok(!url.includes('sk-TEST'));
  assert.equal(init.headers.authorization, 'Bearer sk-TESTKEYTESTKEYTESTKEY');
});

test('401 and 403 are distinct, actionable auth errors', async () => {
  await assert.rejects(client(stubFetch([{ status: 401 }])).get('/x'),
    (e) => e.code === 'UNAUTHENTICATED' && /rejected the credential/.test(e.message));
  await assert.rejects(client(stubFetch([{ status: 403 }])).get('/x'),
    (e) => e.code === 'UNAUTHENTICATED' && /lacks the required permission/.test(e.message));
});

test('retries an idempotent GET on 503 and succeeds', async () => {
  const stub = stubFetch([{ status: 503 }, { status: 503 }, { status: 200, body: '{"ok":true}' }]);
  assert.deepEqual(await client(stub).get('/x'), { ok: true });
  assert.equal(stub.calls.length, 3);
});

test('INV-5 at transport level: a POST is never retried', async () => {
  const stub = stubFetch([{ status: 503 }, { status: 200, body: '{}' }]);
  await assert.rejects(client(stub).post('/send', { to: 'x' }), (e) => e.code === 'PROVIDER_FAILURE');
  assert.equal(stub.calls.length, 1, 'a side-effecting POST must not be retried');
});

test('a POST may opt in to retry when the endpoint is idempotent', async () => {
  const stub = stubFetch([{ status: 503 }, { status: 200, body: '{"ok":1}' }]);
  await client(stub).request('POST', '/idem', { body: {}, retryable: true });
  assert.equal(stub.calls.length, 2);
});

test('4xx that is not retryable fails immediately', async () => {
  const stub = stubFetch([{ status: 400, body: '{"error":"bad"}' }]);
  await assert.rejects(client(stub).get('/x'), (e) => e.retryable === false);
  assert.equal(stub.calls.length, 1);
});

test('a transport failure is retryable and typed', async () => {
  const stub = stubFetch([Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }), { status: 200, body: '{}' }]);
  await client(stub).get('/x');
  assert.equal(stub.calls.length, 2);
});

test('INV-6: an error never becomes a success value', async () => {
  const stub = stubFetch([{ status: 500 }]);
  await assert.rejects(client(stub, { maxRetries: 1 }).get('/x'));
});

test('error details do not leak the credential', async () => {
  const stub = stubFetch([{ status: 400, body: '{"message":"key sk-TESTKEYTESTKEYTESTKEY is bad"}' }]);
  try {
    await client(stub).get('/x');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(!JSON.stringify(e.toJSON()).includes('TESTKEYTESTKEY'));
  }
});
