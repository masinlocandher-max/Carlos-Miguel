import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, EVENT, GENESIS } from '../src/core/audit.js';
import { fixedClock } from '../src/core/clock.js';

function newLog() {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-audit-'));
  return { path: join(dir, 'audit.jsonl'), log: new AuditLog(join(dir, 'audit.jsonl'), { clock: fixedClock('2026-01-01T00:00:00Z') }) };
}

test('chains records and verifies', () => {
  const { log } = newLog();
  assert.equal(log.head(), GENESIS);
  const a = log.write(EVENT.BOOT, { mode: 'test' });
  const b = log.write(EVENT.NOTE, { msg: 'hello' });
  assert.equal(b.prev, a.hash);
  assert.deepEqual(log.verifyChain(), { ok: true, length: 2, brokenAt: null, reason: null });
});

test('detects tampering with a middle record', () => {
  const { path, log } = newLog();
  log.write(EVENT.BOOT, { mode: 'test' });
  log.write(EVENT.NOTE, { msg: 'original' });
  log.write(EVENT.NOTE, { msg: 'third' });

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.data.msg = 'rewritten';
  lines[1] = JSON.stringify(tampered);
  writeFileSync(path, `${lines.join('\n')}\n`);

  const result = new AuditLog(path).verifyChain();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
  assert.equal(result.reason, 'hash-mismatch');
});

test('detects a deleted record', () => {
  const { path, log } = newLog();
  log.write(EVENT.BOOT, {});
  log.write(EVENT.NOTE, { msg: 'deleteme' });
  log.write(EVENT.NOTE, { msg: 'after' });
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  writeFileSync(path, `${[lines[0], lines[2]].join('\n')}\n`);
  const result = new AuditLog(path).verifyChain();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'prev-mismatch');
});

test('redacts secrets before writing (INV-8)', () => {
  const { path, log } = newLog();
  log.write(EVENT.PROVIDER_CALL, { apiKey: 'sk-ABCDEFGHIJKLMNOPQRSTUV', note: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' });
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('ABCDEFGHIJKLMNOPQRSTUV'));
  assert.ok(!raw.includes('ghp_abcdefghijkl'));
});

test('receipt traces one correlated action', () => {
  const { log } = newLog();
  const cid = 'corr-1';
  log.write(EVENT.APPROVAL_REQUESTED, {}, { correlationId: cid });
  log.write(EVENT.APPROVAL_GRANTED, {}, { correlationId: cid });
  log.write(EVENT.EXECUTION_SUCCEEDED, {}, { correlationId: cid, outcome: 'ok' });
  log.write(EVENT.NOTE, {}, { correlationId: 'other' });
  const receipt = log.receipt(cid);
  assert.equal(receipt.steps.length, 3);
  assert.equal(receipt.terminal, EVENT.EXECUTION_SUCCEEDED);
});
