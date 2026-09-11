import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSeal, verifySeal, buildManifest, generateSealKeypair, keyFingerprint,
  publicKeyOf, normalizeKey, resolveAnchor, signedPayload, SEALED_PATHS, PUBLIC_KEY_FILE,
} from '../src/core/integrity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = generateSealKeypair();
const ATTACKER = generateSealKeypair();

/** A throwaway checkout of the sealed set, sealed by the owner. */
function sandbox({ anchor = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-seal-test-'));
  for (const rel of SEALED_PATHS) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(ROOT, rel), dest);
  }
  writeFileSync(join(dir, 'SEAL.json'), JSON.stringify(createSeal(dir, { privateKey: OWNER.privateKey }), null, 2));
  if (anchor) writeFileSync(join(dir, PUBLIC_KEY_FILE), `${OWNER.publicKey.trim()}\n`);
  return dir;
}

const NO_ENV = {};

test('a clean, owner-signed core verifies as pinned', () => {
  const s = verifySeal(sandbox(), { env: NO_ENV });
  assert.equal(s.ok, true);
  assert.equal(s.signed, true);
  assert.equal(s.pinned, true);
  assert.equal(s.trust, 'pinned');
});

test('verification needs no secret at all', () => {
  // The whole point of the asymmetric design: this call passes no key.
  const s = verifySeal(sandbox(), { env: NO_ENV });
  assert.equal(s.ok, true);
  assert.equal(s.anchorSource, PUBLIC_KEY_FILE);
});

test('modifying any sealed file breaks verification', () => {
  for (const target of ['src/core/policy.js', 'src/tools/index.js', 'src/adapters/workspace.js', 'jewel.mjs']) {
    const dir = sandbox();
    const path = join(dir, target);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n// silently added\n`);
    const s = verifySeal(dir, { env: NO_ENV });
    assert.equal(s.ok, false, `${target} tamper was not detected`);
    assert.equal(s.trust, 'broken');
    assert.ok(s.violations.some((v) => v.path === target && v.reason === 'modified'));
  }
});

test('deleting a sealed file is detected', () => {
  const dir = sandbox();
  rmSync(join(dir, 'src/core/audit.js'));
  const s = verifySeal(dir, { env: NO_ENV });
  assert.equal(s.ok, false);
  assert.ok(s.violations.some((v) => v.reason === 'deleted'));
});

// --- The attack the symmetric design could not stop ------------------------

test('an attacker who edits code cannot re-sign it under the owner key', () => {
  const dir = sandbox();
  const path = join(dir, 'src/core/policy.js');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n// backdoor\n`);

  // They re-seal with their own key, which is all they can do.
  writeFileSync(join(dir, 'SEAL.json'), JSON.stringify(createSeal(dir, { privateKey: ATTACKER.privateKey }), null, 2));

  const s = verifySeal(dir, { env: NO_ENV });
  assert.equal(s.signed, true, 'their signature is internally valid');
  assert.equal(s.pinned, false, 'but it does not match the trusted key');
  assert.equal(s.ok, false, 'so the core is refused');
  assert.equal(s.trust, 'unpinned');
  assert.ok(s.violations.some((v) => v.reason === 'public-key-mismatch'));
});

test('an attacker who also rewrites the anchor is caught by an external pin', () => {
  const dir = sandbox();
  const path = join(dir, 'src/core/policy.js');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n// backdoor\n`);
  writeFileSync(join(dir, 'SEAL.json'), JSON.stringify(createSeal(dir, { privateKey: ATTACKER.privateKey }), null, 2));
  // They control the repo, so they replace the in-repo trust anchor too.
  writeFileSync(join(dir, PUBLIC_KEY_FILE), `${ATTACKER.publicKey.trim()}\n`);

  // Against the repo alone it now looks self-consistent. This is the honest
  // limit of an in-repo anchor, and why the pin exists.
  assert.equal(verifySeal(dir, { env: NO_ENV }).trust, 'pinned');

  // CI pins the real public key as a plain variable. That catches it.
  const pinned = verifySeal(dir, { env: { JEWEL_SEAL_PUBLIC_KEY: OWNER.publicKey } });
  assert.equal(pinned.ok, false);
  assert.equal(pinned.pinned, false);
  assert.equal(pinned.anchorSource, 'env');
  assert.match(pinned.summary, /does NOT match the trusted key/);
});

test('an environment pin overrides the in-repo anchor', () => {
  const dir = sandbox();
  const s = verifySeal(dir, { env: { JEWEL_SEAL_PUBLIC_KEY: OWNER.publicKey } });
  assert.equal(s.anchorSource, 'env');
  assert.equal(s.pinned, true);
});

test('with no anchor anywhere, a self-signed core is reported as unpinned', () => {
  const s = verifySeal(sandbox({ anchor: false }), { env: NO_ENV });
  assert.equal(s.signed, true);
  assert.equal(s.pinned, false);
  assert.equal(s.trust, 'unpinned');
  assert.match(s.summary, /no trusted key to check it against/);
});

// --- Legacy and hygiene ----------------------------------------------------

test('a legacy symmetric (v1) seal is refused, not silently accepted', () => {
  const dir = sandbox();
  const seal = JSON.parse(readFileSync(join(dir, 'SEAL.json'), 'utf8'));
  seal.version = 1;
  writeFileSync(join(dir, 'SEAL.json'), JSON.stringify(seal, null, 2));
  const s = verifySeal(dir, { env: NO_ENV });
  assert.equal(s.ok, false);
  assert.match(s.summary, /symmetric seals let any verifier also forge one/i);
});

test('a missing seal reports unsealed rather than pretending to be fine', () => {
  const s = verifySeal(mkdtempSync(join(tmpdir(), 'jewel-noseal-')), { env: NO_ENV });
  assert.equal(s.ok, false);
  assert.equal(s.present, false);
});

test('the signed payload is domain-separated and version-tagged', () => {
  const payload = signedPayload({ root: 'abc', constitutionVersion: '1.0.0' }).toString();
  assert.ok(payload.startsWith('JEWEL_SEAL_V2\n'), 'missing domain prefix');
  assert.ok(payload.includes('abc'));
  assert.ok(payload.includes('1.0.0'), 'constitution version must be bound');
  // A signature over one root must not validate for another.
  assert.notEqual(
    signedPayload({ root: 'abc', constitutionVersion: '1.0.0' }).toString(),
    signedPayload({ root: 'abd', constitutionVersion: '1.0.0' }).toString(),
  );
});

test('the root digest changes when any byte changes', () => {
  const dir = sandbox();
  const before = buildManifest(dir).root;
  const path = join(dir, 'src/core/ids.js');
  writeFileSync(path, `${readFileSync(path, 'utf8')} `);
  assert.notEqual(buildManifest(dir).root, before);
});

test('fingerprints are stable, comparable and key-specific', () => {
  assert.equal(keyFingerprint(OWNER.publicKey), keyFingerprint(OWNER.publicKey));
  assert.notEqual(keyFingerprint(OWNER.publicKey), keyFingerprint(ATTACKER.publicKey));
  assert.match(keyFingerprint(OWNER.publicKey), /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);
  // Whitespace differences must not read as a different key.
  assert.equal(keyFingerprint(OWNER.publicKey), keyFingerprint(`  ${OWNER.publicKey}\n\n`));
});

test('the public key derives from the private key, so a pair can be checked', () => {
  assert.equal(publicKeyOf(OWNER.privateKey), normalizeKey(OWNER.publicKey));
  assert.notEqual(publicKeyOf(ATTACKER.privateKey), normalizeKey(OWNER.publicKey));
  assert.equal(publicKeyOf('not a key'), null);
});

test('anchor resolution prefers an explicit pin, then env, then the repo file', () => {
  const dir = sandbox();
  assert.equal(resolveAnchor(dir, { publicKey: OWNER.publicKey }, {}).source, 'option');
  assert.equal(resolveAnchor(dir, {}, { JEWEL_SEAL_PUBLIC_KEY: OWNER.publicKey }).source, 'env');
  assert.equal(resolveAnchor(dir, {}, {}).source, PUBLIC_KEY_FILE);
  assert.equal(resolveAnchor(mkdtempSync(join(tmpdir(), 'jewel-bare-')), {}, {}).source, 'none');
});

test('the sealed set covers the whole capability surface', () => {
  for (const required of [
    'src/core/constitution.js', 'src/core/policy.js', 'src/core/approvals.js',
    'src/core/agent/executor.js', 'src/tools/index.js', 'src/adapters/workspace.js',
    'src/runtime/config.js', 'src/runtime/server.js', 'jewel.mjs',
  ]) {
    assert.ok(SEALED_PATHS.includes(required), `${required} must be sealed`);
  }
  // The trust anchor must NOT be inside the set it attests to.
  assert.ok(!SEALED_PATHS.includes(PUBLIC_KEY_FILE));
});

test('the committed seal matches the committed code', () => {
  const s = verifySeal(ROOT);
  assert.equal(s.ok, true, `repository seal is stale: ${s.summary}`);
});
