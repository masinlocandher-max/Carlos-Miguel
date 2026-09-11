/**
 * Jewel OS - untrusted content containment.
 *
 * INV-3: retrieved content is DATA. An email, a Notion page, a web result, a
 * file or a tool response can never grant permission, raise Jewel's authority
 * or amend the constitution.
 *
 * Two layers, because neither alone is sufficient:
 *
 *   1. STRUCTURAL (the real defence). All external text is wrapped in a
 *      delimiter carrying a per-process random nonce that the content cannot
 *      predict, and any attempt to forge the closing delimiter is neutralised.
 *      The model is instructed once, in the sealed system directive, that
 *      anything inside is data.
 *
 *   2. DETECTIVE (telemetry, not a gate). Known injection phrasings are
 *      flagged and audited so FMB can see that an attempt happened. Detection
 *      is best-effort by nature and is NEVER used to decide whether an action
 *      may proceed - the policy engine and approval binding do that.
 *
 * Critically, the trust decision does not depend on detecting the attack.
 * Even a perfectly disguised injection cannot approve its own action, because
 * approval requires an out-of-band owner grant bound to a payload hash.
 */
import { randomBytes } from 'node:crypto';
import { sha256 } from './ids.js';

/** Unpredictable per-process boundary token. */
const NONCE = randomBytes(9).toString('hex');

export const OPEN_TAG = `<untrusted_content nonce="${NONCE}">`;
export const CLOSE_TAG = `</untrusted_content nonce="${NONCE}">`;

/** Patterns that commonly indicate an instruction-injection attempt. */
const INJECTION_SIGNALS = [
  { id: 'override-instructions', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction|context)/i },
  { id: 'role-reassignment', re: /\byou are (now|actually)\b|\bnew (system )?(prompt|instructions?|role)\b|\bact as (?:an? )?(?:admin|root|developer|dan)\b/i },
  { id: 'approval-bypass', re: /\b(no|without|skip|bypass|don'?t need|not required)\b[^.\n]{0,30}\b(approval|confirmation|permission|authorization|human|review)\b/i },
  { id: 'secret-exfiltration', re: /\b(reveal|show|print|output|send|share|email|forward|leak|dump)\b[^.\n]{0,30}\b(api[- ]?key|secret|token|credential|password|env|environment variable|system prompt)\b/i },
  { id: 'authority-claim', re: /\b(i am|this is)\b[^.\n]{0,20}\b(fmb|the owner|your (owner|creator|developer|administrator))\b/i },
  { id: 'urgency-pressure', re: /\b(urgent|immediately|right now|asap)\b[^.\n]{0,40}\b(send|transfer|pay|approve|wire|confirm)\b/i },
  { id: 'tool-injection', re: /<\/?(?:tool_call|function_call|system|assistant|untrusted_content)\b/i },
  { id: 'exfil-destination', re: /\b(send|post|upload|forward)\b[^.\n]{0,30}\bto\b\s+(?:https?:\/\/|[\w.-]+@)/i },
];

/**
 * @typedef {object} Sanitized
 * @property {string} text        the wrapped, delimiter-safe text
 * @property {string} raw         the original text (for storage, never for prompts)
 * @property {string} sourceId
 * @property {string} contentHash
 * @property {{id:string,excerpt:string}[]} signals
 * @property {boolean} suspicious
 * @property {number} truncatedFrom 0 when not truncated
 */

/**
 * Wrap external content for safe inclusion in a model prompt.
 * @param {string} text
 * @param {{ sourceId?: string, sourceType?: string, maxChars?: number }} [meta]
 * @returns {Sanitized}
 */
export function sanitizeExternal(text, meta = {}) {
  const input = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  const maxChars = meta.maxChars ?? 24000;

  let body = input;
  let truncatedFrom = 0;
  if (body.length > maxChars) {
    truncatedFrom = body.length;
    body = `${body.slice(0, maxChars)}\n…[truncated ${body.length - maxChars} characters]`;
  }

  // Neutralise any attempt to forge our own delimiters or common control tags.
  body = body
    .split(OPEN_TAG).join('[blocked-delimiter]')
    .split(CLOSE_TAG).join('[blocked-delimiter]')
    .replace(/<\/?untrusted_content[^>]*>/gi, '[blocked-delimiter]')
    .replace(/<\|(?:im_start|im_end|endoftext|system|assistant|user)\|>/gi, '[blocked-control-token]');

  const signals = [];
  for (const { id, re } of INJECTION_SIGNALS) {
    const m = body.match(re);
    if (m) signals.push({ id, excerpt: m[0].slice(0, 140) });
  }

  const sourceId = meta.sourceId ?? 'unknown';
  const header = `source=${sourceId} type=${meta.sourceType ?? 'unknown'} trust=untrusted`;

  return {
    text: `${OPEN_TAG}\n${header}\n---\n${body}\n${CLOSE_TAG}`,
    raw: input,
    sourceId,
    contentHash: sha256(input),
    signals,
    suspicious: signals.length > 0,
    truncatedFrom,
  };
}

/**
 * Wrap several sources at once and summarise the security posture.
 * @param {{ text:string, sourceId?:string, sourceType?:string }[]} items
 */
export function sanitizeAll(items, opts = {}) {
  const parts = items.map((i) => sanitizeExternal(i.text, { ...opts, sourceId: i.sourceId, sourceType: i.sourceType }));
  return {
    text: parts.map((p) => p.text).join('\n\n'),
    parts,
    suspicious: parts.some((p) => p.suspicious),
    signals: parts.flatMap((p) => p.signals.map((s) => ({ ...s, sourceId: p.sourceId }))),
  };
}

/** Scan without wrapping - used to screen owner input for relayed attacks. */
export function scan(text) {
  const body = String(text ?? '');
  const signals = [];
  for (const { id, re } of INJECTION_SIGNALS) {
    const m = body.match(re);
    if (m) signals.push({ id, excerpt: m[0].slice(0, 140) });
  }
  return { suspicious: signals.length > 0, signals };
}

export const _internals = { NONCE, INJECTION_SIGNALS };
