#!/usr/bin/env node
/**
 * Jewel OS - seal ceremony (Ed25519).
 *
 *   node tools/seal-cli.mjs verify     verify the sealed core (exit 1 on failure)
 *   node tools/seal-cli.mjs seal       re-seal after an approved change
 *   node tools/seal-cli.mjs keygen     generate a new owner keypair
 *   node tools/seal-cli.mjs status     print the manifest without changing it
 *
 * Signing needs JEWEL_SEAL_PRIVATE_KEY, which only FMB holds and which must
 * never be given to CI. Verification needs only the public key, so CI, a
 * reviewer or a stranger can check Jewel without being able to forge one.
 */
import { writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSeal, verifySeal, buildManifest, generateSealKeypair,
  keyFingerprint, publicKeyOf, normalizeKey, resolveAnchor,
  SEAL_FILE, PUBLIC_KEY_FILE,
} from '../src/core/integrity.js';
import { CONSTITUTION_VERSION } from '../src/core/constitution.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? 'verify';
const out = (...a) => process.stdout.write(`${a.join(' ')}\n`);

/** Read the private key from the env var, or from a file it points at. */
function readPrivateKey() {
  const inline = process.env.JEWEL_SEAL_PRIVATE_KEY;
  if (inline) return normalizeKey(inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline);
  const file = process.env.JEWEL_SEAL_PRIVATE_KEY_FILE;
  if (file && existsSync(file)) return normalizeKey(readFileSync(file, 'utf8'));
  return null;
}

if (command === 'keygen') {
  const { publicKey, privateKey } = generateSealKeypair();
  const target = join(ROOT, PUBLIC_KEY_FILE);

  if (existsSync(target) && !process.argv.includes('--force')) {
    out(`${PUBLIC_KEY_FILE} already exists. Refusing to replace the trust anchor.`);
    out('Replacing it would orphan every seal made with the current key.');
    out('If you are deliberately rotating, re-run with --force.');
    process.exit(1);
  }

  writeFileSync(target, `${publicKey.trim()}\n`);
  out('New owner keypair generated.');
  out('');
  out(`  public key   -> ${PUBLIC_KEY_FILE} (commit this, it is meant to be public)`);
  out(`  fingerprint  ${keyFingerprint(publicKey)}`);
  out('');
  out('  ┌─ PRIVATE KEY - SAVE IT NOW, IT IS SHOWN ONCE ─────────────────┐');
  out('  │ Put it in your password manager. Never commit it, never give  │');
  out('  │ it to CI, never paste it into chat.                           │');
  out('  └───────────────────────────────────────────────────────────────┘');
  out('');
  out(privateKey.trim());
  out('');
  out('Then seal with it:');
  out('  JEWEL_SEAL_PRIVATE_KEY="$(cat your-key.pem)" npm run seal');
  process.exit(0);
}

if (command === 'verify') {
  const status = verifySeal(ROOT);
  out(status.ok ? '✔' : '✘', status.summary);
  out(`   trust        ${status.trust}`);
  out(`   signing key  ${status.fingerprint}`);
  out(`   anchor       ${status.anchorSource}`);

  if (status.violations.length) {
    out('');
    for (const v of status.violations) out(`   ${v.reason.padEnd(28)} ${v.path}`);
  }

  if (!status.ok || status.trust !== 'pinned') {
    out('');
    if (status.trust === 'unpinned' && status.anchorSource === 'none') {
      out(`No trusted key to check against. Commit ${PUBLIC_KEY_FILE}, or set`);
      out('JEWEL_SEAL_PUBLIC_KEY (it is public - a plain CI variable, not a secret).');
    } else if (status.trust === 'unpinned') {
      out('The core was signed by a key that is NOT the trusted one. Do not run this');
      out('build. Find out who signed it before doing anything else.');
    } else {
      out('If you changed a core file on purpose, re-seal:');
      out('   JEWEL_SEAL_PRIVATE_KEY=... npm run seal');
    }
  }
  process.exit(status.ok ? 0 : 1);
}

if (command === 'status') {
  const manifest = buildManifest(ROOT);
  const anchor = resolveAnchor(ROOT);
  out(`root digest  ${manifest.root}`);
  out(`files        ${manifest.files.length}`);
  out(`anchor       ${anchor.source}${anchor.key ? ` (${keyFingerprint(anchor.key)})` : ''}`);
  for (const f of manifest.files) out(`  ${f.sha256.slice(0, 12)}  ${String(f.bytes).padStart(6)}  ${f.path}`);
  process.exit(0);
}

if (command === 'seal') {
  const privateKey = readPrivateKey();
  if (!privateKey) {
    out('No signing key. Set JEWEL_SEAL_PRIVATE_KEY (or JEWEL_SEAL_PRIVATE_KEY_FILE).');
    out('');
    out('If you have not made one yet:  node tools/seal-cli.mjs keygen');
    out('');
    out('Never put this key in CI. CI verifies with the public key and must not');
    out('be able to sign.');
    process.exit(1);
  }

  const derived = publicKeyOf(privateKey);
  if (!derived) {
    out('That is not a valid Ed25519 private key.');
    process.exit(1);
  }

  // Refuse to sign with a key that does not match the committed anchor, unless
  // the operator is explicitly rotating. Otherwise a slip silently produces a
  // core nobody can trust.
  const anchor = resolveAnchor(ROOT);
  const rotating = process.argv.includes('--rotate');
  if (anchor.key && normalizeKey(anchor.key) !== derived && !rotating) {
    out('The signing key does not match the trusted key.');
    out('');
    out(`  trusted (${anchor.source})  ${keyFingerprint(anchor.key)}`);
    out(`  signing key             ${keyFingerprint(derived)}`);
    out('');
    out('Sealing with it would produce a core that fails verification everywhere.');
    out('If you are deliberately rotating keys, re-run with --rotate; that also');
    out(`rewrites ${PUBLIC_KEY_FILE}.`);
    process.exit(1);
  }

  const sealPath = join(ROOT, SEAL_FILE);
  const previous = existsSync(sealPath) ? JSON.parse(readFileSync(sealPath, 'utf8')) : null;

  const seal = createSeal(ROOT, {
    privateKey,
    sealedBy: process.env.JEWEL_SEAL_BY ?? 'FMB',
    constitutionVersion: CONSTITUTION_VERSION,
  });

  // Chain of custody: each seal records the one it replaced.
  seal.previousRoot = previous?.root ?? null;
  seal.sealNumber = (previous?.sealNumber ?? 0) + 1;

  writeFileSync(sealPath, `${JSON.stringify(seal, null, 2)}\n`);

  if (rotating || !anchor.key) {
    writeFileSync(join(ROOT, PUBLIC_KEY_FILE), `${derived}\n`);
    try { chmodSync(join(ROOT, PUBLIC_KEY_FILE), 0o644); } catch { /* best effort */ }
  }

  out(`✔ Sealed ${seal.files.length} core files.`);
  out(`  seal #${seal.sealNumber}`);
  out(`  root  ${seal.root}`);
  if (previous?.root && previous.root !== seal.root) out(`  was   ${previous.root}`);
  out(`  key   ${keyFingerprint(derived)}`);
  if (rotating) out(`  rotated: ${PUBLIC_KEY_FILE} now holds the new public key. Commit it.`);

  const check = verifySeal(ROOT);
  out('');
  out(check.ok ? `  verified: ${check.trust}` : `  WARNING: the new seal does not verify - ${check.summary}`);
  process.exit(check.ok ? 0 : 1);
}

out(`Unknown command: ${command}`);
out('Usage: node tools/seal-cli.mjs [verify|seal|keygen|status]');
process.exit(2);
