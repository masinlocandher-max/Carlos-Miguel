import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactText, containsSecret, registerSecret, clearRegisteredSecrets, fingerprint } from '../src/core/redact.js';

test('redacts sensitive keys regardless of value', () => {
  const out = redact({ apiKey: 'plainvalue', password: 'hunter2', ok: 'visible' });
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.ok, 'visible');
});

test('redacts credential-shaped values under innocent keys', () => {
  const out = redact({ note: 'key is sk-ABCDEFGHIJKLMNOPQRSTUV here' });
  assert.ok(out.note.includes('[redacted:openai-key]'));
  assert.ok(!out.note.includes('ABCDEFGHIJKLMNOPQRSTUV'));
});

test('redacts github, notion, google and jwt shapes', () => {
  const text = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'ntn_abcdefghijklmnopqrstuvwxyz0123',
    'ya29.abcdefghijklmnopqrstuvwxyz0123',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  ].join(' ');
  const out = redactText(text);
  for (const leak of ['ghp_abcdef', 'ntn_abcdef', 'ya29.abcdef', 'eyJhbGciOiJIUzI1NiJ9.eyJ']) {
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  }
});

test('registered secret values are scrubbed even with unknown shape', () => {
  clearRegisteredSecrets();
  registerSecret('correct-horse-battery-staple');
  const out = redact({ transcript: 'she said correct-horse-battery-staple aloud' });
  assert.ok(!out.transcript.includes('correct-horse'));
  assert.ok(containsSecret('correct-horse-battery-staple'));
  clearRegisteredSecrets();
});

test('handles cycles, errors and dates without throwing', () => {
  const cyclic = { name: 'a' };
  cyclic.self = cyclic;
  const out = redact({ cyclic, when: new Date('2026-01-01T00:00:00.000Z'), err: new Error('sk-ABCDEFGHIJKLMNOPQRSTUV') });
  assert.equal(out.cyclic.self, '[circular]');
  assert.equal(out.when, '2026-01-01T00:00:00.000Z');
  assert.ok(out.err.message.includes('[redacted:openai-key]'));
});

test('fingerprint reveals shape but not value', () => {
  const fp = fingerprint('sk-supersecretvalue');
  assert.ok(!fp.includes('supersecret'));
  assert.match(fp, /^len\d+:/);
});
