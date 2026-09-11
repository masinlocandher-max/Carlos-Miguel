/**
 * Jewel OS - configuration.
 *
 * Config comes from the environment only. There is no config file that could be
 * committed with a secret in it by accident, and every secret value is
 * registered with the redactor the moment it is read, so it cannot appear in a
 * log, an audit record or an error payload from that point on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerSecret } from '../core/redact.js';
import { MODE } from '../core/policy.js';
import { SENSITIVITY } from '../core/memory.js';

/**
 * Minimal .env loader. Zero dependency, and deliberately conservative:
 *
 *   - a variable already present in the real environment ALWAYS wins, so a
 *     stale file can never silently override what an operator exported;
 *   - values are read literally. No shell expansion, no command substitution,
 *     no `${VAR}` interpolation - an env file must not be able to execute
 *     anything or reach another variable;
 *   - only `.local` files are read, and those are gitignored, so the loader
 *     cannot pick up something that was committed by accident.
 *
 * @param {string} path
 * @param {NodeJS.ProcessEnv} env
 * @returns {number} how many variables were applied
 */
export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return 0;
  let applied = 0;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key in env) continue;               // the real environment wins

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');     // strip trailing comments on bare values
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    // A placeholder is not a value. Treat it as absent so `doctor` reports the
    // gap honestly instead of Jewel trying to authenticate with the word
    // "your_openai_key_here".
    if (/^your_.*_here$/.test(value) || value === '') continue;

    env[key] = value;
    applied += 1;
  }
  return applied;
}

/** Load the operator's env files, nearest-first. Real environment still wins. */
export function loadEnvFiles(root, env = process.env) {
  let applied = 0;
  for (const name of ['.env.local', '.env']) applied += loadEnvFile(join(root, name), env);
  return applied;
}

const SECRET_KEYS = [
  // The Ed25519 private key. JEWEL_SEAL_PUBLIC_KEY is deliberately NOT here -
  // a public key is meant to be public, and redacting it would hide the very
  // fingerprint an operator needs to compare.
  'JEWEL_SEAL_PRIVATE_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NOTION_API_KEY',
  'GITHUB_TOKEN', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN',
];

/** @param {NodeJS.ProcessEnv} [env] */
export function loadConfig(env = process.env) {
  for (const key of SECRET_KEYS) if (env[key]) registerSecret(env[key]);

  const mode = env.JEWEL_EXECUTION_MODE === MODE.LIVE ? MODE.LIVE : MODE.DRYRUN;

  return {
    owner: env.JEWEL_OWNER ?? 'FMB',
    dataDir: env.JEWEL_DATA_DIR ?? null,
    /** Safe by default: live mode must be chosen, never inherited. */
    mode,
    locale: env.JEWEL_LOCALE ?? 'en',
    sealPrivateKey: env.JEWEL_SEAL_PRIVATE_KEY ?? null,
    sealPublicKey: env.JEWEL_SEAL_PUBLIC_KEY ?? null,

    anthropicKey: env.ANTHROPIC_API_KEY ?? null,
    anthropicModel: env.ANTHROPIC_MODEL ?? null,
    openaiKey: env.OPENAI_API_KEY ?? null,
    openaiModel: env.OPENAI_MODEL ?? null,
    preferProvider: env.JEWEL_MODEL_PROVIDER ?? null,

    notionApiKey: env.NOTION_API_KEY ?? null,
    githubToken: env.GITHUB_TOKEN ?? null,
    googleAccessToken: env.GOOGLE_ACCESS_TOKEN ?? null,

    /**
     * Accounts Jewel is authorized to act as. Authority is NEVER inferred from
     * an address mentioned in conversation - it must be listed here.
     */
    accounts: splitList(env.JEWEL_ACCOUNTS),
    scopes: splitList(env.JEWEL_SCOPES) ?? ['notion', 'email', 'calendar', 'drive', 'github'],
    clearance: env.JEWEL_CLEARANCE ?? SENSITIVITY.RESTRICTED,

    maxSteps: intOr(env.JEWEL_MAX_STEPS, 12),
    approvalTtlMs: intOr(env.JEWEL_APPROVAL_TTL_MS, 24 * 60 * 60 * 1000),
  };
}

function splitList(v) {
  if (!v) return null;
  const parts = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function intOr(v, fallback) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** What is and is not configured - printed by `doctor`, never with values. */
export function configReport(cfg) {
  return {
    owner: cfg.owner,
    mode: cfg.mode,
    locale: cfg.locale,
    sealPrivateKeyPresent: !!cfg.sealPrivateKey,
    model: cfg.anthropicKey ? 'anthropic' : cfg.openaiKey ? 'openai' : 'offline',
    providers: {
      notion: !!cfg.notionApiKey,
      google: !!cfg.googleAccessToken,
      github: !!cfg.githubToken,
    },
    authorizedAccounts: cfg.accounts?.length ?? 0,
    scopes: cfg.scopes,
  };
}
