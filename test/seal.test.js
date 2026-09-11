import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeal, verifySeal, buildManifest, signManifest, SEALED_PATHS } from '../src/core/integrity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'owner-key-for-tests';

/** Copy the sealed set into a temp root so tampering never touches the repo. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-seal-test-'));
  for (const rel of SEALED_PATHS) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(ROOT, rel), dest);
  }
  writeFileSync(join(dir, 'SEAL.json'), JSON.stringify(createSeal(dir, { key: KEY }), null, 2));
  return dir;
}

test('a clean core verifies and is owner-signed', () => {
  const s = verifySeal(sandbox(), { key: KEY });
  assert.equal(s.ok, true);
  assert.equal(s.signed, true);
});

test('modifying any sealed file breaks verification', () => {
  for (const target of ['src/core/policy.js', 'src/tools/index.js', 'src/adapters/workspace.js', 'jewel.mjs']) {
    const dir = sandbox();
    const path = join(dir, target);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n// silently added\n`);
    const s = verifySeal(dir, { key: KEY });
    assert.equal(s.ok, false, `${target} tamper was not detected`);
    assert.ok(s.violations.some((v) => v.path === target && v.reason === 'modified'));
  }
});

test('deleting a sealed file is detected', () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'SEAL.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'SEAL.json'), 'utf8')) }, null, 2));
  const seal = JSON.parse(readFileSync(join(dir, 'SEAL.json'), 'utf8'));
  seal.files = seal.files.filter((f) => f.path !== 'src/core/audit.js');
  writeFileSync(join(dir, 'SEAL.json'), JSON.stringify(seal, null, 2));
  const s = verifySeal(dir, { key: KEY });
  assert.equal(s.ok, false);
});

test('an attacker who edits code cannot forge a signature without the key', () => {
  const dir = sandbox();
  const path = join(dir, 'src/core/policy.js');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n// backdoor\n`);

  // The attacker re-seals with their own key, as they would.
  writeFileSync(join(dir, 'SEAL.json'), JSON.stringify(createSeal(dir, { key: 'attacker-key' }), null, 2));

  // Hashes now match their tampered files, but FMB's key does not verify.
  const asOwner = verifySeal(dir, { key: KEY });
  assert.equal(asOwner.signed, false);
  assert.equal(asOwner.ok, false);
  assert.ok(asOwner.violations.some((v) => v.reason === 'signature-mismatch'));
});

test('a missing seal reports unsealed rather than pretending to be fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-noseal-'));
  const s = verifySeal(dir);
  assert.equal(s.ok, false);
  assert.equal(s.present, false);
});

test('the root digest changes when any byte changes', () => {
  const dir = sandbox();
  const before = buildManifest(dir).root;
  const path = join(dir, 'src/core/ids.js');
  writeFileSync(path, `${readFileSync(path, 'utf8')} `);
  assert.notEqual(buildManifest(dir).root, before);
});

test('signing is deterministic and key-dependent', () => {
  const root = 'a'.repeat(64);
  assert.equal(signManifest(root, KEY), signManifest(root, KEY));
  assert.notEqual(signManifest(root, KEY), signManifest(root, 'other-key'));
});

test('the sealed set covers the whole capability surface', () => {
  for (const required of [
    'src/core/constitution.js', 'src/core/policy.js', 'src/core/approvals.js',
    'src/core/agent/executor.js', 'src/tools/index.js', 'src/adapters/workspace.js',
    'src/runtime/config.js', 'jewel.mjs',
  ]) {
    assert.ok(SEALED_PATHS.includes(required), `${required} must be sealed`);
  }
});

test('the committed seal matches the committed code', () => {
  const s = verifySeal(ROOT);
  assert.equal(s.ok, true, `repository seal is stale: ${s.summary}`);
});
