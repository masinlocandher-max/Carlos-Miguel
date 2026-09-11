/**
 * Jewel OS - capability seal.
 *
 * WHAT THIS ACTUALLY GUARANTEES (read this before trusting it):
 *
 *   It does NOT make files unwritable. Anyone with repo access can edit them.
 *   What it does is make an edited core UNUSABLE and VISIBLE:
 *
 *   1. Every file in the sealed set is hashed (sha256).
 *   2. The sorted (path, hash) manifest is itself hashed -> the root digest.
 *   3. The root digest is signed with HMAC-SHA256 under JEWEL_SEAL_KEY,
 *      a secret only the owner holds. It is never committed.
 *   4. The runtime verifies the manifest on every boot. Any byte change in the
 *      sealed set changes the root digest, the signature no longer matches,
 *      and Jewel refuses to start.
 *   5. CI re-verifies on every push, so a tampered core cannot reach main
 *      silently.
 *
 *   A third party can therefore fork and gut Jewel - but they cannot produce a
 *   build that passes verification and still calls itself Jewel. Modification
 *   is not prevented; it is made undeniable. That is the honest bound.
 *
 * DEGRADED MODE: without JEWEL_SEAL_KEY the runtime still verifies the manifest
 * hashes (tamper detection) but reports `signed: false`. High and critical risk
 * tools are disabled in that state - see policy.js.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sha256, canonicalJson, safeEqual } from './ids.js';
import { SealError } from './errors.js';

/**
 * The sealed set. Every path here is part of Jewel's capability contract.
 * Adding a file to the core REQUIRES adding it here and re-sealing.
 */
export const SEALED_PATHS = Object.freeze([
  'src/core/constitution.js',
  'src/core/integrity.js',
  'src/core/policy.js',
  'src/core/approvals.js',
  'src/core/idempotency.js',
  'src/core/audit.js',
  'src/core/untrusted.js',
  'src/core/memory.js',
  'src/core/redact.js',
  'src/core/ids.js',
  'src/core/errors.js',
  'src/core/clock.js',
  'src/core/store.js',
  'src/core/schema.js',
  'src/core/tools/registry.js',
  'src/core/agent/loop.js',
  'src/core/agent/planner.js',
  'src/core/agent/executor.js',
  'src/core/kernel.js',
  // The capability surface itself. tools/index.js declares every risk tier and
  // approval gate - leaving it unsealed would let a builder quietly drop the
  // gate on email.send without breaking verification.
  'src/tools/index.js',
  // The only code that reaches the outside world.
  'src/adapters/http.js',
  'src/adapters/model.js',
  'src/adapters/workspace.js',
  // Boot surface: config decides mode and authorized accounts; jewel.mjs wires
  // the kernel. Both can change behaviour without touching core/.
  'src/runtime/config.js',
  // The control API. It grants no authority of its own, but it decides who
  // may reach the executor at all.
  'src/runtime/server.js',
  'jewel.mjs',
]);

export const SEAL_FILE = 'SEAL.json';
const SEAL_VERSION = 1;

/**
 * Build the manifest for the sealed set.
 * @param {string} root repository root
 * @returns {{ version:number, algorithm:string, files:{path:string,sha256:string,bytes:number}[], root:string }}
 */
export function buildManifest(root) {
  const files = [];
  for (const rel of [...SEALED_PATHS].sort()) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      throw new SealError(`Sealed file is missing: ${rel}`, { path: rel });
    }
    const bytes = readFileSync(abs);
    files.push({ path: rel.split(sep).join('/'), sha256: sha256(bytes), bytes: bytes.length });
  }
  const root_ = sha256(canonicalJson(files.map((f) => [f.path, f.sha256])));
  return { version: SEAL_VERSION, algorithm: 'sha256+hmac-sha256', files, root: root_ };
}

/** @param {string} rootDigest @param {string} key */
export function signManifest(rootDigest, key) {
  return createHmac('sha256', key).update(`jewel-seal:v${SEAL_VERSION}:${rootDigest}`).digest('hex');
}

/**
 * Produce a complete seal document ready to write to SEAL.json.
 * @param {string} root
 * @param {{ key?: string, sealedAt?: string, sealedBy?: string, constitutionVersion?: string }} opts
 */
export function createSeal(root, opts = {}) {
  const manifest = buildManifest(root);
  const seal = {
    version: SEAL_VERSION,
    algorithm: manifest.algorithm,
    sealedAt: opts.sealedAt ?? new Date().toISOString(),
    sealedBy: opts.sealedBy ?? 'FMB',
    constitutionVersion: opts.constitutionVersion ?? 'unknown',
    root: manifest.root,
    files: manifest.files,
    signature: opts.key ? signManifest(manifest.root, opts.key) : null,
  };
  return seal;
}

/**
 * @typedef {object} SealStatus
 * @property {boolean} ok          manifest hashes match the files on disk
 * @property {boolean} signed      a valid owner signature was verified
 * @property {boolean} present     SEAL.json exists
 * @property {string}  root        recomputed root digest
 * @property {string}  [expected]  root digest recorded in SEAL.json
 * @property {{path:string,reason:string}[]} violations
 * @property {string}  summary
 */

/**
 * Verify the sealed core against a seal document.
 * Never throws for a tampered core - returns a status the caller can act on,
 * so the failure path itself is auditable.
 *
 * `sealPath` exists for key rotation and for testing against a seal signed
 * with a different key. It is NOT a bypass: whichever document is named, every
 * file hash and the owner signature are still checked in full, and choosing
 * the path requires already controlling how the process starts.
 *
 * @param {string} root
 * @param {{ key?: string|null, sealPath?: string|null }} [opts]
 * @returns {SealStatus}
 */
export function verifySeal(root, opts = {}) {
  const sealPath = opts.sealPath ?? join(root, SEAL_FILE);
  if (!existsSync(sealPath)) {
    return { ok: false, signed: false, present: false, root: '', violations: [{ path: SEAL_FILE, reason: 'missing' }], summary: 'SEAL.json is missing. The capability core is unsealed.' };
  }

  let seal;
  try {
    seal = JSON.parse(readFileSync(sealPath, 'utf8'));
  } catch {
    return { ok: false, signed: false, present: true, root: '', violations: [{ path: SEAL_FILE, reason: 'unparseable' }], summary: 'SEAL.json could not be parsed.' };
  }

  const violations = [];
  const recorded = new Map((seal.files ?? []).map((f) => [f.path, f.sha256]));

  for (const rel of [...SEALED_PATHS].sort()) {
    const abs = join(root, rel);
    const key = rel.split(sep).join('/');
    if (!existsSync(abs)) { violations.push({ path: key, reason: 'deleted' }); continue; }
    const actual = sha256(readFileSync(abs));
    const expected = recorded.get(key);
    if (!expected) violations.push({ path: key, reason: 'not-in-seal' });
    else if (!safeEqual(actual, expected)) violations.push({ path: key, reason: 'modified' });
    recorded.delete(key);
  }
  for (const orphan of recorded.keys()) violations.push({ path: orphan, reason: 'removed-from-sealed-set' });

  let recomputedRoot = '';
  try {
    recomputedRoot = buildManifest(root).root;
  } catch {
    recomputedRoot = '';
  }

  const hashesOk = violations.length === 0 && recomputedRoot !== '' && safeEqual(recomputedRoot, seal.root ?? '');
  if (recomputedRoot && seal.root && !safeEqual(recomputedRoot, seal.root) && violations.length === 0) {
    violations.push({ path: SEAL_FILE, reason: 'root-digest-mismatch' });
  }

  const key = opts.key ?? process.env.JEWEL_SEAL_KEY ?? null;
  let signed = false;
  if (hashesOk && key && seal.signature) {
    signed = safeEqual(signManifest(seal.root, key), seal.signature);
    if (!signed) violations.push({ path: SEAL_FILE, reason: 'signature-mismatch' });
  }

  const summary = !hashesOk
    ? `Capability seal BROKEN: ${violations.map((v) => `${v.path} (${v.reason})`).join(', ')}`
    : signed
      ? 'Capability seal verified and owner-signed.'
      : key
        ? 'Capability seal hashes verified but the owner signature did not match.'
        : 'Capability seal hashes verified. No owner key present - running in degraded (unsigned) mode.';

  return { ok: hashesOk && (!key || signed), signed, present: true, root: recomputedRoot, expected: seal.root, violations, summary };
}

/**
 * Enforce the seal at boot.
 * @param {string} root
 * @param {{ allowUnsealed?: boolean, key?: string|null, sealPath?: string|null }} [opts]
 * @returns {SealStatus}
 */
export function enforceSeal(root, opts = {}) {
  const status = verifySeal(root, { key: opts.key, sealPath: opts.sealPath });
  if (status.ok) return status;
  if (opts.allowUnsealed && status.violations.every((v) => v.path === SEAL_FILE && v.reason === 'missing')) {
    return status;
  }
  throw new SealError(status.summary, { violations: status.violations });
}
