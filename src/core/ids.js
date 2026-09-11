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

/**
 * Domain-separated, length-framed digest.
 *
 * Canonical JSON alone already delimits fields by name, so it is not vulnerable
 * to the classic concatenation ambiguity where ("ab","c") and ("a","bc") hash
 * alike. Two weaker problems remain, and this closes both:
 *
 *   1. CROSS-DOMAIN REUSE. The same hash function was previously used, without
 *      a tag, for approval bindings, audit records, idempotency keys and two
 *      fingerprints. Nothing structurally prevented a digest computed in one
 *      role from being meaningful in another. Every domain now carries its own
 *      prefix, so a digest is only ever valid where it was minted.
 *
 *   2. IMPLICIT FRAMING. Canonical JSON makes framing a property of the
 *      serializer. Here each component is written as `label:byteLength` before
 *      its bytes, so the boundaries are explicit in the hashed stream itself
 *      and do not depend on the serializer staying correct.
 *
 * @param {string} domain versioned tag, e.g. 'JEWEL_APPROVAL_V1'
 * @param {[string, string|null|undefined][]} parts ordered (label, value) pairs
 * @returns {string} sha256 hex
 */
export function domainDigest(domain, parts) {
  const h = createHash('sha256');
  h.update(`${domain}\n`, 'utf8');
  h.update(`parts:${parts.length}\n`, 'utf8');
  for (const [label, value] of parts) {
    // Absent and empty must not collide: an approval bound to account=null is
    // a different thing from one bound to the empty string, and a framing that
    // cannot tell them apart is the same defect this function exists to avoid.
    if (value === null || value === undefined) {
      h.update(`${label}:absent\n`, 'utf8');
      continue;
    }
    const bytes = Buffer.from(String(value), 'utf8');
    h.update(`${label}:${bytes.length}\n`, 'utf8');
    h.update(bytes);
    h.update('\n', 'utf8');
  }
  return h.digest('hex');
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
