/**
 * Jewel OS - identifiers and canonical hashing.
 *
 * Canonical JSON is the backbone of the security model: approvals, the audit
 * chain and idempotency keys all bind to `canonicalHash(payload)`. If a payload
 * changes by a single byte, every binding built on it becomes invalid.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys sorted recursively,
 * undefined dropped, no incidental whitespace.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'undefined' ? null : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (typeof v === 'undefined') continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** @param {unknown} value @returns {string} sha256 hex of the canonical form */
export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** @param {string|Buffer} data @returns {string} */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-time string comparison; false on length mismatch. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** @param {string} prefix */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Short, human-quotable reference derived from a hash (approval codes). */
export function shortRef(hash) {
  return hash.slice(0, 10).toUpperCase();
}
