/**
 * Jewel OS - secret redaction.
 *
 * Acceptance requirement: "No private knowledge or credentials appear in Git,
 * frontend bundles or logs." Everything that leaves the process through a log,
 * an audit record, an error payload or an HTTP response passes through here.
 *
 * Redaction is pattern-based AND registry-based. Known live secret values are
 * registered at boot so that even an unrecognized format is scrubbed.
 */

const REGISTERED = new Set();

/** Register a live secret value so it is scrubbed anywhere it appears. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) REGISTERED.add(value);
}

export function clearRegisteredSecrets() { REGISTERED.clear(); }

/**
 * Key names whose values are always replaced, regardless of content.
 *
 * Matching is SEGMENT-based, not substring-based. An earlier version used an
 * unanchored regex, which meant `pin` matched `pinned`, and `auth` matched
 * `author`, `authorized` and `authenticated` - silently redacting honest,
 * non-secret state and making the system harder to trust rather than safer.
 * Over-redaction is not a safe default: it hides the fields an operator needs
 * to verify.
 */
const SENSITIVE_SEGMENTS = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'secrets', 'token', 'credential',
  'credentials', 'authorization', 'auth', 'cookie', 'cookies', 'otp', 'ssn',
  'bearer', 'signature', 'jwt', 'pin', 'seed', 'mnemonic',
]);

/** `key` is only sensitive in company: apiKey yes, publicKey no. */
const SENSITIVE_KEY_QUALIFIERS = new Set([
  'api', 'private', 'secret', 'seal', 'signing', 'access', 'encryption', 'master', 'session',
]);

/**
 * Quantity words. `token` is sensitive, but `tokenCount` is a usage metric and
 * redacting it hides cost data while protecting nothing - the value is a number,
 * not a credential.
 */
const QUANTITY = new Set(['count', 'counts', 'usage', 'limit', 'limits', 'budget', 'total', 'used', 'remaining', 'length', 'size']);

/** Fields that are meant to be visible even though they look key-adjacent. */
const PUBLIC_FIELDS = new Set([
  'publickey', 'keyfingerprint', 'fingerprint', 'anchorsource', 'publickeyfile',
]);

/** Split a key into lowercase segments across camelCase, snake_case and kebab. */
function segmentsOf(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/** @param {string} key */
export function isSensitiveKey(key) {
  const flat = String(key).toLowerCase().replace(/[_\-.]/g, '');
  if (PUBLIC_FIELDS.has(flat)) return false;

  const parts = segmentsOf(key);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (SENSITIVE_SEGMENTS.has(part)) {
      const after = parts[i + 1];
      if ((part === 'token' || part === 'tokens') && after && QUANTITY.has(after)) continue;
      return true;
    }
    if (part === 'key' || part === 'keys') {
      const before = parts[i - 1];
      if (before && SENSITIVE_KEY_QUALIFIERS.has(before)) return true;
    }
  }
  return false;
}

/** Value shapes that look like credentials even under an innocent key name. */
const PATTERNS = [
  [/\bsk-[A-Za-z0-9_\-]{16,}\b/g, '[redacted:openai-key]'],
  [/\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g, '[redacted:anthropic-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted:github-pat]'],
  [/\bntn_[A-Za-z0-9]{20,}\b/g, '[redacted:notion-key]'],
  [/\bsecret_[A-Za-z0-9]{30,}\b/g, '[redacted:notion-key]'],
  [/\bya29\.[A-Za-z0-9_\-]{20,}\b/g, '[redacted:google-oauth]'],
  [/\b1\/\/[A-Za-z0-9_\-]{30,}\b/g, '[redacted:google-refresh]'],
  [/\bAIza[A-Za-z0-9_\-]{30,}\b/g, '[redacted:google-key]'],
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g, '[redacted:slack-token]'],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, '[redacted:jwt]'],
  [/\b-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  [/\bBearer\s+[A-Za-z0-9._\-]{16,}/gi, 'Bearer [redacted]'],
];

/** @param {string} text */
export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const value of REGISTERED) {
    if (value && out.includes(value)) out = out.split(value).join('[redacted:registered-secret]');
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Deep-redact any structure. Cycles are tolerated. Non-plain objects are
 * stringified defensively rather than trusted.
 * @param {unknown} value
 */
export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), code: value.code };
  }
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKey(k)) { out[k] = '[redacted]'; continue; }
    out[k] = redact(v, seen);
  }
  return out;
}

/** True if the value still looks like it carries a credential after redaction. */
export function containsSecret(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return false;
  for (const v of REGISTERED) if (v && text.includes(v)) return true;
  return PATTERNS.some(([re]) => { re.lastIndex = 0; return re.test(text); });
}

/** Fingerprint a secret for audit without revealing it. */
export function fingerprint(value) {
  if (!value) return 'none';
  const s = String(value);
  return `len${s.length}:${s.slice(0, 2)}…${s.slice(-2)}`;
}
