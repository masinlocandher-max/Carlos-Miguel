import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVault, SENSITIVITY, VERIFICATION, KIND, clears } from '../src/core/memory.js';
import { AuditLog } from '../src/core/audit.js';
import { fixedClock } from '../src/core/clock.js';

function newVault() {
  const dir = mkdtempSync(join(tmpdir(), 'jewel-mem-'));
  const clock = fixedClock('2026-01-01T00:00:00Z');
  const audit = new AuditLog(join(dir, 'audit.jsonl'), { clock });
  const vault = new MemoryVault({ dir: join(dir, 'memory'), audit, clock });
  vault.registerSource({ id: 'notion:projects', type: 'notion', label: 'Projects DB', sensitivity: SENSITIVITY.PRIVATE });
  return { vault, audit, clock };
}

const FMB = { authenticated: true, id: 'FMB', clearance: SENSITIVITY.RESTRICTED };

function sample(vault, over = {}) {
  return vault.remember({
    kind: KIND.FACT,
    subject: 'Studio launch date',
    content: { date: '2026-10-14' },
    project: 'studio',
    provenance: { sourceId: 'notion:projects', sourceRevision: 'rev-1', locator: 'page/123' },
    ...over,
  });
}

test('records require a registered, authorized source', () => {
  const { vault } = newVault();
  assert.throws(() => vault.remember({ kind: KIND.FACT, subject: 'x', content: 'y', provenance: { sourceId: 'unknown:src' } }),
    (e) => e.code === 'UNAUTHORIZED');
  assert.throws(() => vault.remember({ kind: KIND.FACT, subject: 'x', content: 'y' }),
    (e) => e.code === 'INVALID_INPUT');
});

test('provenance is complete on every record', () => {
  const { vault } = newVault();
  const rec = sample(vault);
  for (const field of ['sourceId', 'sourceRevision', 'retrievedAt', 'locator']) {
    assert.ok(rec.provenance[field] != null, `missing provenance.${field}`);
  }
  assert.ok(rec.sensitivity && rec.verification && rec.contentHash);
});

test('INV-9: new records are unverified and flagged as not citable', () => {
  const { vault } = newVault();
  sample(vault);
  const out = vault.search({ query: 'launch' }, FMB);
  assert.equal(out.results[0].verification, VERIFICATION.UNVERIFIED);
  assert.equal(out.unverified.length, 1);
  assert.equal(vault.toContext(out.results)[0].citable, false);
});

test('verification promotes a record to citable', () => {
  const { vault } = newVault();
  const rec = sample(vault);
  vault.verify(rec.id, { sourceRevision: 'rev-2' });
  const out = vault.search({ query: 'launch' }, FMB);
  assert.equal(out.results[0].verification, VERIFICATION.VERIFIED);
  assert.equal(vault.toContext(out.results)[0].source, 'notion:projects@rev-2');
});

test('supersession hides the stale record but keeps its history', () => {
  const { vault } = newVault();
  const old = sample(vault);
  const fresh = sample(vault, { content: { date: '2026-11-02' }, supersedes: old.id });
  const out = vault.search({ query: 'launch' }, FMB);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].id, fresh.id);
  assert.equal(vault.get(old.id).verification, VERIFICATION.STALE);
  assert.equal(vault.get(old.id).supersededBy, fresh.id);
  assert.equal(vault.search({ query: 'launch', includeStale: true }, FMB).results.length, 2);
});

test('conflicts surface instead of one side winning silently', () => {
  const { vault } = newVault();
  const a = sample(vault);
  const b = sample(vault, { content: { date: '2026-12-01' } });
  vault.markConflict(a.id, b.id, 'two Notion pages disagree');
  const out = vault.search({ query: 'launch' }, FMB);
  assert.equal(out.conflicts.length, 2);
});

test('revoking a source purges content and blocks retrieval', () => {
  const { vault } = newVault();
  const rec = sample(vault);
  assert.equal(vault.search({ query: 'launch' }, FMB).results.length, 1);

  const { purged } = vault.revokeSource('notion:projects', 'access withdrawn');
  assert.equal(purged, 1);
  assert.equal(vault.search({ query: 'launch' }, FMB).results.length, 0);

  const tombstone = vault.get(rec.id);
  assert.equal(tombstone.content, null);
  assert.equal(tombstone.verification, VERIFICATION.REVOKED);
  assert.ok(tombstone.contentHash, 'audit continuity hash retained');
});

test('a revoked source cannot accept new records', () => {
  const { vault } = newVault();
  vault.revokeSource('notion:projects');
  assert.throws(() => sample(vault), (e) => e.code === 'UNAUTHORIZED');
});

test('INV-7: unauthenticated retrieval is denied and audited', () => {
  const { vault, audit } = newVault();
  sample(vault);
  assert.throws(() => vault.search({ query: 'launch' }, { authenticated: false }), (e) => e.code === 'UNAUTHORIZED');
  assert.equal(audit.read((r) => r.event === 'security.auth.denied').length, 1);
});

test('sensitivity is enforced on read, not just labelled', () => {
  const { vault } = newVault();
  vault.registerSource({ id: 'notion:private', type: 'notion', label: 'Private' });
  vault.remember({ kind: KIND.NOTE, subject: 'Restricted note', content: 'sealed',
    sensitivity: SENSITIVITY.RESTRICTED, provenance: { sourceId: 'notion:private' } });

  const low = vault.search({}, { authenticated: true, id: 'assistant', clearance: SENSITIVITY.INTERNAL });
  assert.equal(low.results.length, 0);
  assert.equal(low.withheld, 1);
  assert.equal(vault.search({}, FMB).results.length, 1);
  assert.equal(clears(SENSITIVITY.PRIVATE, SENSITIVITY.RESTRICTED), false);
});

test('refuses to store anything credential-shaped', () => {
  const { vault } = newVault();
  assert.throws(() => vault.remember({
    kind: KIND.NOTE, subject: 'creds', content: { key: 'sk-ABCDEFGHIJKLMNOPQRSTUV' },
    provenance: { sourceId: 'notion:projects' },
  }), (e) => e.code === 'INVALID_INPUT');
});

test('stats and audit chain stay consistent', () => {
  const { vault, audit } = newVault();
  sample(vault); sample(vault, { subject: 'Brand palette', kind: KIND.BRAND_RULE });
  const s = vault.stats();
  assert.equal(s.records, 2);
  assert.equal(s.authorizedSources, 1);
  assert.equal(audit.verifyChain().ok, true);
});
