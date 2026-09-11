/**
 * Jewel OS - first-run setup.
 *
 * The gap between "cloned the repo" and "Jewel is usable" was a page of manual
 * steps. This closes it in one command, without ever making a security choice
 * on FMB's behalf:
 *
 *   - generates an Ed25519 owner keypair and an API token;
 *   - writes the PRIVATE key and the token to .env.local, which is gitignored;
 *   - writes the PUBLIC key to jewel.pub, which is meant to be committed - it
 *     is the trust anchor everyone else verifies against, and publishing it
 *     gives away no ability to sign;
 *   - refuses to overwrite an existing file unless explicitly forced, because
 *     silently replacing the signing key would orphan every prior seal;
 *   - seals the core with the new private key;
 *   - leaves execution mode at dryrun. Going live stays a deliberate act.
 *
 * The private key is printed ONCE. That is the unavoidable tradeoff: a key you
 * cannot see is a key you cannot store, and an owner-held key that lives only
 * in a file on one machine is one disk failure from lockout.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSeal, generateSealKeypair, keyFingerprint, SEAL_FILE, PUBLIC_KEY_FILE } from '../core/integrity.js';
import { CONSTITUTION_VERSION, OWNER } from '../core/constitution.js';

const ENV_FILE = '.env.local';

/** 256 bits, hex. Long enough that guessing is not a strategy. */
export function generateKey(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

/**
 * @param {string} root
 * @param {{ force?:boolean, seal?:boolean, now?:string }} [opts]
 * @returns {{ created:boolean, envPath:string, sealKey:string|null,
 *             apiToken:string|null, sealed:object|null, warnings:string[] }}
 */
export function initialize(root, opts = {}) {
  const envPath = join(root, ENV_FILE);
  const warnings = [];

  if (existsSync(envPath) && !opts.force) {
    return {
      created: false,
      envPath,
      privateKey: null,
      publicKey: null,
      fingerprint: null,
      apiToken: null,
      sealed: null,
      warnings: [
        `${ENV_FILE} already exists. Jewel will not overwrite it.`,
        'Replacing the seal key would orphan every seal made with the old one.',
        'If you really want to start over, back up the existing file first and re-run with --force.',
      ],
    };
  }

  if (existsSync(envPath) && opts.force) {
    const backup = `${envPath}.backup.${Date.now()}`;
    copyFileSync(envPath, backup);
    warnings.push(`Your previous ${ENV_FILE} was backed up to ${backup.split('/').pop()}.`);
  }

  // Refuse to write secrets anywhere git can see them.
  const ignore = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : '';
  if (!/^\s*\.env\.\*\.local\s*$/m.test(ignore) && !/^\s*\.env\.local\s*$/m.test(ignore) && !/^\s*\.env\.\*\s*$/m.test(ignore)) {
    throw new Error(`.gitignore does not exclude ${ENV_FILE}. Refusing to write secrets where git can see them.`);
  }

  const { publicKey, privateKey } = generateSealKeypair();
  const apiToken = generateKey(24);

  writeFileSync(envPath, envTemplate({ privateKey, apiToken, now: opts.now ?? new Date().toISOString() }), { mode: 0o600 });

  // The public half is the trust anchor. It belongs in the repository.
  writeFileSync(join(root, PUBLIC_KEY_FILE), `${publicKey.trim()}\n`, { mode: 0o644 });

  let sealed = null;
  if (opts.seal !== false) {
    const seal = createSeal(root, { privateKey, sealedBy: OWNER.handle, constitutionVersion: CONSTITUTION_VERSION });
    const sealPath = join(root, SEAL_FILE);
    const previous = existsSync(sealPath) ? JSON.parse(readFileSync(sealPath, 'utf8')) : null;
    seal.previousRoot = previous?.root ?? null;
    seal.sealNumber = (previous?.sealNumber ?? 0) + 1;
    writeFileSync(sealPath, `${JSON.stringify(seal, null, 2)}\n`);
    sealed = {
      root: seal.root, files: seal.files.length, sealNumber: seal.sealNumber,
      signed: !!seal.signature, fingerprint: keyFingerprint(publicKey),
    };
  }

  return { created: true, envPath, privateKey, publicKey, fingerprint: keyFingerprint(publicKey), apiToken, sealed, warnings };
}

function envTemplate({ privateKey, apiToken, now }) {
  return `# Jewel OS - local configuration
# Generated ${now}
#
# THIS FILE CONTAINS SECRETS. It is gitignored. Never commit it, never paste it
# into chat, never put it in Notion.
#
# Copy JEWEL_SEAL_PRIVATE_KEY into your password manager now. If you lose it you
# cannot re-seal the core, and Jewel will refuse high-risk actions until you do.
#
# NEVER give this key to CI. CI verifies with the PUBLIC key in jewel.pub and
# must not be able to sign. That is the whole point of the asymmetric design.

# --- Capability seal (owner-held private key) -------------------------------
JEWEL_SEAL_PRIVATE_KEY="${privateKey.trim().replace(/\n/g, '\\n')}"

# --- Local control API ------------------------------------------------------
JEWEL_API_TOKEN=${apiToken}
JEWEL_API_PORT=7777

# --- Runtime ----------------------------------------------------------------
JEWEL_OWNER=FMB
JEWEL_LOCALE=en

# Safety posture. Leave as dryrun until you have watched Jewel work and trust
# what she proposes. Nothing reaches the outside world in dryrun.
JEWEL_EXECUTION_MODE=dryrun

# Accounts Jewel may act as, comma separated. Authority is NEVER inferred from
# an address mentioned in conversation - it must be listed here.
# Example: JEWEL_ACCOUNTS=you@yourdomain.com
JEWEL_ACCOUNTS=

JEWEL_SCOPES=notion,email,calendar,drive,github

# --- Model provider (one is enough) -----------------------------------------
# Without a model key Jewel says so plainly rather than inventing answers.
ANTHROPIC_API_KEY=your_anthropic_key_here
ANTHROPIC_MODEL=claude-opus-5
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-4.1

# --- Workspace providers ----------------------------------------------------
NOTION_API_KEY=your_notion_key_here
GITHUB_TOKEN=your_github_token_here
GOOGLE_ACCESS_TOKEN=your_google_access_token_here

# --- Command centre ---------------------------------------------------------
# The UI reads these at build time. Keep the token identical to JEWEL_API_TOKEN.
VITE_JEWEL_API_URL=http://127.0.0.1:7777
VITE_JEWEL_API_TOKEN=${apiToken}
`;
}

/** What still needs a human before Jewel is fully usable. */
export function remainingSteps(cfg, seal) {
  const steps = [];
  if (seal?.trust === 'unpinned') {
    steps.push({ id: 'anchor', text: 'The core is signed by a key that does not match jewel.pub. Do not run this build until you know who signed it.' });
  } else if (!seal?.pinned) {
    steps.push({ id: 'seal', text: 'Seal the core with your key: JEWEL_SEAL_PRIVATE_KEY=... npm run seal' });
  }
  if (!cfg.anthropicKey && !cfg.openaiKey) steps.push({ id: 'model', text: 'Add a model key (ANTHROPIC_API_KEY or OPENAI_API_KEY) so Jewel can answer.' });
  if (!cfg.accounts?.length) steps.push({ id: 'accounts', text: 'List the accounts Jewel may act as in JEWEL_ACCOUNTS.' });
  if (!cfg.notionApiKey && !cfg.googleAccessToken && !cfg.githubToken) {
    steps.push({ id: 'providers', text: 'Connect at least one workspace provider (Notion, Google or GitHub).' });
  }
  if (cfg.mode !== 'live') steps.push({ id: 'mode', text: 'When you are ready for real actions, set JEWEL_EXECUTION_MODE=live.' });
  return steps;
}
