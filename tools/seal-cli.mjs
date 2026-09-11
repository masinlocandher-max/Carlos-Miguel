#!/usr/bin/env node
/**
 * Jewel OS - seal ceremony.
 *
 *   node tools/seal-cli.mjs verify    verify the sealed core (exit 1 on failure)
 *   node tools/seal-cli.mjs seal      re-seal after an approved change
 *   node tools/seal-cli.mjs status    print the manifest without changing it
 *
 * Sealing requires JEWEL_SEAL_KEY, which only FMB holds. Without it the seal is
 * written UNSIGNED: hashes still detect tampering, but high-risk capabilities
 * stay disabled until an owner-signed seal exists. That is the intended failure
 * mode - a builder without the key can change code, but cannot produce a Jewel
 * that will act on the world.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeal, verifySeal, buildManifest, SEAL_FILE } from '../src/core/integrity.js';
import { CONSTITUTION_VERSION } from '../src/core/constitution.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? 'verify';
const key = process.env.JEWEL_SEAL_KEY ?? null;

function out(...args) { process.stdout.write(`${args.join(' ')}\n`); }

if (command === 'verify') {
  const status = verifySeal(ROOT, { key });
  out(status.ok ? '✔' : '✘', status.summary);
  if (status.violations.length) {
    for (const v of status.violations) out(`   ${v.reason.padEnd(28)} ${v.path}`);
    out('');
    out('If you changed a core file on purpose, re-seal with:');
    out('   JEWEL_SEAL_KEY=... npm run seal');
  }
  if (status.ok && !status.signed && key) out('  note: an owner key was present but no signature matched.');
  if (status.ok && !key) out('  note: no JEWEL_SEAL_KEY set, so the owner signature was not checked.');
  process.exit(status.ok ? 0 : 1);
}

if (command === 'status') {
  const manifest = buildManifest(ROOT);
  out(`root digest  ${manifest.root}`);
  out(`files        ${manifest.files.length}`);
  for (const f of manifest.files) out(`  ${f.sha256.slice(0, 12)}  ${String(f.bytes).padStart(6)}  ${f.path}`);
  process.exit(0);
}

if (command === 'seal') {
  const sealPath = join(ROOT, SEAL_FILE);
  const previous = existsSync(sealPath) ? JSON.parse(readFileSync(sealPath, 'utf8')) : null;

  const seal = createSeal(ROOT, {
    key,
    sealedBy: process.env.JEWEL_SEAL_BY ?? 'FMB',
    constitutionVersion: CONSTITUTION_VERSION,
  });

  // Keep the chain of custody: each seal records the one it replaced.
  seal.previousRoot = previous?.root ?? null;
  seal.sealNumber = (previous?.sealNumber ?? 0) + 1;

  writeFileSync(sealPath, `${JSON.stringify(seal, null, 2)}\n`);

  out(`✔ Sealed ${seal.files.length} core files.`);
  out(`  seal #${seal.sealNumber}`);
  out(`  root  ${seal.root}`);
  if (previous?.root && previous.root !== seal.root) out(`  was   ${previous.root}`);
  out(seal.signature
    ? '  signature: owner-signed. Full capability enabled.'
    : '  signature: NONE. Set JEWEL_SEAL_KEY and re-seal to enable high-risk capabilities.');
  process.exit(0);
}

out(`Unknown command: ${command}`);
out('Usage: node tools/seal-cli.mjs [verify|seal|status]');
process.exit(2);
