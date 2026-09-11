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

/** Key names whose values are always replaced, regardless of content. */
const SENSITIVE_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|authorization|auth|cookie|session|credential|private[-_]?key|refresh[-_]?token|access[-_]?token|client[-_]?secret|signature|seal[-_]?key|bearer|otp|pin|ssn)/i;

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
    if (SENSITIVE_KEY.test(k)) { out[k] = '[redacted]'; continue; }
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
