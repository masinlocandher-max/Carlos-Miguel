/**
 * Jewel OS - configuration.
 *
 * Config comes from the environment only. There is no config file that could be
 * committed with a secret in it by accident, and every secret value is
 * registered with the redactor the moment it is read, so it cannot appear in a
 * log, an audit record or an error payload from that point on.
 */
import { registerSecret } from '../core/redact.js';
import { MODE } from '../core/policy.js';
import { SENSITIVITY } from '../core/memory.js';

const SECRET_KEYS = [
  'JEWEL_SEAL_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NOTION_API_KEY',
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
    sealKey: env.JEWEL_SEAL_KEY ?? null,

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
    sealKeyPresent: !!cfg.sealKey,
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
