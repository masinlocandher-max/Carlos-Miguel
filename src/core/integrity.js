/**
 * Jewel OS - capability seal (Ed25519, asymmetric).
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT.
 *
 * It does NOT make files unwritable. Anyone with repo access can edit them.
 * What it does is make an edited core UNUSABLE and VISIBLE:
 *
 *   1. Every file in the sealed set is hashed (SHA-256).
 *   2. The sorted (path, hash) manifest is hashed -> the root digest.
 *   3. The root digest is signed with the owner's Ed25519 PRIVATE key, which
 *      never leaves FMB's machine and never enters CI.
 *   4. Anyone - the runtime, CI, a reviewer - verifies with the PUBLIC key.
 *      Verification confers no ability to sign.
 *   5. The runtime verifies on every boot. Any byte change breaks the root
 *      digest, the signature fails, and Jewel refuses to act.
 *
 * WHY ASYMMETRIC. The previous design used HMAC-SHA256. Under HMAC the
 * verifier needs the same secret the signer uses, so putting the key in CI so
 * CI could verify also gave CI - and anyone able to alter a workflow or read a
 * secret - the power to MINT valid seals. That defeated the entire claim. With
 * Ed25519 the private key stays with FMB, CI holds only the public key, and CI
 * can therefore check Jewel but never forge one.
 *
 * THE TRUST ANCHOR PROBLEM, STATED HONESTLY.
 * The seal embeds the public key it was signed with. On its own that proves
 * nothing: an attacker can edit the core, sign it with THEIR key, and embed
 * THEIR public key, producing a document that verifies against itself. A
 * signature is only meaningful against a key you already trust.
 *
 * So verification has three levels, and they are never collapsed:
 *
 *   ok       the files on disk match the manifest
 *   signed   the signature is valid for the key embedded in the seal
 *   pinned   that key matches an anchor supplied from OUTSIDE the seal
 *
 * `pinned` is the one that matters. The anchor is `jewel.pub` in the repo, or
 * JEWEL_SEAL_PUBLIC_KEY in the environment (a PUBLIC value - safe as a plain
 * CI variable, not a secret). When both exist they must agree. Policy grants
 * high-risk capability only when the seal is PINNED, so an attacker who
 * re-signs with their own key gets `signed: true, pinned: false` and Jewel
 * still will not act.
 *
 * The anchor itself must be trusted out of band at least once. `doctor` prints
 * its fingerprint for exactly that reason. That residual step cannot be
 * removed by any amount of cryptography - it can only be made visible.
 */
import { createHash, sign as edSign, verify as edVerify, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { sha256, canonicalJson, safeEqual } from './ids.js';
import { SealError } from './errors.js';

/**
 * The sealed set. Every path here is part of Jewel's capability contract.
 * Adding a file to the core REQUIRES adding it here and re-sealing.
 *
 * `jewel.pub` is deliberately NOT here: a trust anchor is not covered by the
 * thing it attests to. It is checked separately, against the seal.
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
export const PUBLIC_KEY_FILE = 'jewel.pub';
const SEAL_VERSION = 2;
const SEAL_DOMAIN = 'JEWEL_SEAL_V2';

/** Generate an owner keypair. The private half must never leave the owner. */
export function generateSealKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/** Normalize a PEM so whitespace differences never cause a false mismatch. */
export function normalizeKey(pem) {
  return String(pem ?? '').replace(/\r\n/g, '\n').trim();
}

/** Short, human-comparable fingerprint of a public key. */
export function keyFingerprint(publicKeyPem) {
  const pem = normalizeKey(publicKeyPem);
  if (!pem) return 'none';
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const hex = createHash('sha256').update(der).digest('hex');
  return (hex.match(/.{1,4}/g) ?? []).slice(0, 8).join('-').toUpperCase();
}

/** Derive the public key from a private key, to check a pair matches. */
export function publicKeyOf(privateKeyPem) {
  try {
    return normalizeKey(createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }));
  } catch {
    return null;
  }
}

/**
 * Build the manifest for the sealed set.
 * @param {string} root repository root
 */
export function buildManifest(root) {
  const files = [];
  for (const rel of [...SEALED_PATHS].sort()) {
    const abs = join(root, rel);
    if (!existsSync(abs)) throw new SealError(`Sealed file is missing: ${rel}`, { path: rel });
    const bytes = readFileSync(abs);
    files.push({ path: rel.split(sep).join('/'), sha256: sha256(bytes), bytes: bytes.length });
  }
  const rootDigest = sha256(canonicalJson(files.map((f) => [f.path, f.sha256])));
  return { version: SEAL_VERSION, algorithm: 'sha256+ed25519', files, root: rootDigest };
}

/**
 * The exact bytes that get signed. Domain-separated and version-tagged so a
 * seal signature can never be replayed as a signature over anything else.
 */
export function signedPayload({ root, constitutionVersion }) {
  return Buffer.from(`${SEAL_DOMAIN}\n${root}\n${constitutionVersion ?? 'unknown'}\n`, 'utf8');
}

/**
 * Produce a seal document.
 * @param {string} root
 * @param {{ privateKey?:string, sealedAt?:string, sealedBy?:string, constitutionVersion?:string }} opts
 */
export function createSeal(root, opts = {}) {
  const manifest = buildManifest(root);
  const constitutionVersion = opts.constitutionVersion ?? 'unknown';

  let signature = null;
  let publicKey = null;
  if (opts.privateKey) {
    const priv = normalizeKey(opts.privateKey);
    publicKey = publicKeyOf(priv);
    if (!publicKey) throw new SealError('The signing key is not a valid Ed25519 private key.');
    signature = edSign(null, signedPayload({ root: manifest.root, constitutionVersion }), priv).toString('hex');
  }

  return {
    version: SEAL_VERSION,
    algorithm: manifest.algorithm,
    sealedAt: opts.sealedAt ?? new Date().toISOString(),
    sealedBy: opts.sealedBy ?? 'FMB',
    constitutionVersion,
    root: manifest.root,
    files: manifest.files,
    publicKey,
    signature,
  };
}

/**
 * Resolve the out-of-band trust anchor.
 * Order: explicit option, then JEWEL_SEAL_PUBLIC_KEY (or _FILE), then jewel.pub.
 * @returns {{ key:string|null, source:string }}
 */
export function resolveAnchor(root, opts = {}, env = process.env) {
  if (opts.publicKey) return { key: normalizeKey(opts.publicKey), source: 'option' };

  if (env.JEWEL_SEAL_PUBLIC_KEY) return { key: normalizeKey(env.JEWEL_SEAL_PUBLIC_KEY), source: 'env' };
  if (env.JEWEL_SEAL_PUBLIC_KEY_FILE && existsSync(env.JEWEL_SEAL_PUBLIC_KEY_FILE)) {
    return { key: normalizeKey(readFileSync(env.JEWEL_SEAL_PUBLIC_KEY_FILE, 'utf8')), source: 'env-file' };
  }

  const repoKey = join(root, PUBLIC_KEY_FILE);
  if (existsSync(repoKey)) return { key: normalizeKey(readFileSync(repoKey, 'utf8')), source: PUBLIC_KEY_FILE };

  return { key: null, source: 'none' };
}

/**
 * @typedef {object} SealStatus
 * @property {boolean} ok        manifest hashes match AND, when an anchor
 *                               exists, the signature verifies against it
 * @property {boolean} signed    signature valid for the key inside the seal
 * @property {boolean} pinned    that key matches an out-of-band anchor
 * @property {boolean} present   SEAL.json exists
 * @property {string}  trust     'pinned' | 'unpinned' | 'unsigned' | 'broken'
 * @property {string}  fingerprint
 * @property {string}  anchorSource
 * @property {{path:string,reason:string}[]} violations
 * @property {string}  summary
 */

/**
 * Verify the sealed core. Never throws for a tampered core - returns a status
 * the caller can act on, so the failure path itself is auditable.
 *
 * @param {string} root
 * @param {{ publicKey?:string|null, sealPath?:string|null, env?:object }} [opts]
 * @returns {SealStatus}
 */
export function verifySeal(root, opts = {}) {
  const sealPath = opts.sealPath ?? join(root, SEAL_FILE);
  const env = opts.env ?? process.env;

  const fail = (reason, summary, extra = {}) => ({
    ok: false, signed: false, pinned: false, present: extra.present ?? false,
    trust: 'broken', fingerprint: 'none', anchorSource: 'none', root: '',
    violations: [{ path: SEAL_FILE, reason }], summary, ...extra,
  });

  if (!existsSync(sealPath)) {
    return fail('missing', 'SEAL.json is missing. The capability core is unsealed.');
  }

  let seal;
  try { seal = JSON.parse(readFileSync(sealPath, 'utf8')); }
  catch { return fail('unparseable', 'SEAL.json could not be parsed.', { present: true }); }

  // A v1 (HMAC) seal is refused rather than silently accepted. That design let
  // any verifier also sign; accepting it now would reintroduce the flaw.
  if (Number(seal.version) < SEAL_VERSION) {
    return fail('legacy-symmetric-seal',
      `This is a version ${seal.version} symmetric seal. Symmetric seals let any verifier also forge one. Re-seal with an Ed25519 owner key: jewel seal --rotate.`,
      { present: true });
  }

  // --- file hashes -------------------------------------------------------
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
  try { recomputedRoot = buildManifest(root).root; } catch { recomputedRoot = ''; }

  if (recomputedRoot && seal.root && !safeEqual(recomputedRoot, seal.root) && violations.length === 0) {
    violations.push({ path: SEAL_FILE, reason: 'root-digest-mismatch' });
  }

  const hashesOk = violations.length === 0 && recomputedRoot !== '' && safeEqual(recomputedRoot, seal.root ?? '');

  // --- signature ---------------------------------------------------------
  const embedded = normalizeKey(seal.publicKey);
  const fingerprint = keyFingerprint(embedded);
  const anchor = resolveAnchor(root, opts, env);

  let signed = false;
  if (hashesOk && embedded && seal.signature) {
    try {
      signed = edVerify(
        null,
        signedPayload({ root: seal.root, constitutionVersion: seal.constitutionVersion }),
        embedded,
        Buffer.from(seal.signature, 'hex'),
      );
    } catch { signed = false; }
    if (!signed) violations.push({ path: SEAL_FILE, reason: 'signature-invalid' });
  }

  // --- anchor ------------------------------------------------------------
  // A signature the seal vouches for itself is not evidence. Only agreement
  // with a key supplied from outside the seal makes it mean anything.
  let pinned = false;
  if (anchor.key && embedded) {
    pinned = safeEqual(anchor.key, embedded);
    if (!pinned) violations.push({ path: PUBLIC_KEY_FILE, reason: 'public-key-mismatch' });
  }

  // When an anchor exists, it is authoritative: a valid-looking seal signed by
  // the wrong key is a FAILURE, not a warning.
  const ok = hashesOk && (anchor.key ? (signed && pinned) : true);

  const trust = !hashesOk ? 'broken'
    : !seal.signature ? 'unsigned'
      : signed && pinned ? 'pinned'
        : signed ? 'unpinned'
          : 'broken';

  const summary = (() => {
    if (!hashesOk) return `Capability seal BROKEN: ${violations.map((v) => `${v.path} (${v.reason})`).join(', ')}`;
    if (trust === 'pinned') return `Capability seal verified and owner-signed (key ${fingerprint}).`;
    if (trust === 'unsigned') return 'Capability seal hashes verified but the core is not signed.';
    if (trust === 'unpinned') {
      return anchor.key
        ? `Seal signature is valid but the signing key ${fingerprint} does NOT match the trusted key from ${anchor.source}. Treat this core as untrusted.`
        : `Seal is self-signed by key ${fingerprint} with no trusted key to check it against. Add jewel.pub or set JEWEL_SEAL_PUBLIC_KEY.`;
    }
    return 'Capability seal signature did not verify.';
  })();

  return {
    ok, signed, pinned, present: true, trust, fingerprint,
    anchorSource: anchor.source, root: recomputedRoot, expected: seal.root,
    violations, summary,
  };
}

/**
 * Enforce the seal at boot.
 * @param {string} root
 * @param {{ allowUnsealed?:boolean, publicKey?:string|null, sealPath?:string|null }} [opts]
 */
export function enforceSeal(root, opts = {}) {
  const status = verifySeal(root, opts);
  if (status.ok) return status;
  if (opts.allowUnsealed && !status.present) return status;
  throw new SealError(status.summary, { violations: status.violations });
}
