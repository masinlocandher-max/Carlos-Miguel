/**
 * Jewel OS - durable storage primitives. Zero dependencies.
 *
 * Two shapes, both crash-safe:
 *   AppendLog  append-only JSONL. Never rewritten, never truncated by the
 *              runtime. Used for the audit chain and the idempotency ledger.
 *   JsonTable  a directory of one JSON document per record, written via
 *              write-temp-then-rename so a crash cannot leave a torn file.
 *
 * Storage is local-first so Jewel keeps working when a provider is down.
 * Notion remains the source of truth for owner-visible state; this is the
 * runtime's own ledger.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { NotFoundError, ValidationError } from './errors.js';
import { canonicalJson } from './ids.js';

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Write a file durably: temp file, fsync, atomic rename. */
export function writeFileAtomic(path, contents) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export class AppendLog {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
    ensureDir(dirname(path));
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
  }

  /** @param {object} record @returns {object} the record as written */
  append(record) {
    appendFileSync(this.path, `${canonicalJson(record)}\n`, { mode: 0o600 });
    return record;
  }

  /** @returns {object[]} */
  readAll() {
    const raw = readFileSync(this.path, 'utf8');
    if (!raw) return [];
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); }
      catch { out.push({ __corrupt: true, raw: t.slice(0, 200) }); }
    }
    return out;
  }

  /** Last record, or null. Avoids parsing the whole file for the common case. */
  last() {
    const all = this.readAll();
    return all.length ? all[all.length - 1] : null;
  }

  get size() { return this.readAll().length; }
}

export class JsonTable {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    ensureDir(dir);
  }

  _path(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
      throw new ValidationError('Invalid record id', { id: String(id).slice(0, 64) });
    }
    return join(this.dir, `${id}.json`);
  }

  has(id) { return existsSync(this._path(id)); }

  /** @returns {object} @throws {NotFoundError} */
  get(id) {
    const p = this._path(id);
    if (!existsSync(p)) throw new NotFoundError('Record not found', { id });
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  /** @returns {object|null} */
  find(id) {
    try { return this.get(id); } catch { return null; }
  }

  /** @param {string} id @param {object} record */
  put(id, record) {
    writeFileAtomic(this._path(id), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  /** Compare-and-set on a version field; prevents lost updates. */
  update(id, mutator, versionField = 'version') {
    const current = this.get(id);
    const next = mutator(structuredClone(current));
    const expected = current[versionField] ?? 0;
    if ((next[versionField] ?? 0) !== expected) {
      throw new ValidationError('Concurrent modification detected', { id });
    }
    next[versionField] = expected + 1;
    return this.put(id, next);
  }

  delete(id) {
    const p = this._path(id);
    if (existsSync(p)) { unlinkSync(p); return true; }
    return false;
  }

  ids() {
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  }

  /** @param {(r:object)=>boolean} [predicate] */
  list(predicate) {
    const out = [];
    for (const id of this.ids()) {
      const rec = this.find(id);
      if (!rec) continue;
      if (!predicate || predicate(rec)) out.push(rec);
    }
    return out;
  }
}

/** Resolve and create the runtime data directory. */
export function dataDir(root, override) {
  const dir = override ?? process.env.JEWEL_DATA_DIR ?? join(root, '.jewel');
  ensureDir(dir);
  return dir;
}
