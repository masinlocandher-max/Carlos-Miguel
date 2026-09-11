import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeConnection, describeSeal, feedFor, emptyMessage, orderApprovals,
  expiresIn, uncitable, routeCommand, describeTurn, describeError,
} from './runtime.ts';
import type { Status, Approval, TurnResult, MemoryRecord } from './jewel.ts';
import { JewelUnreachable, JewelApiError } from './jewel.ts';

const status = (over: Partial<Status> = {}): Status => ({
  owner: 'FMB', mode: 'dryrun', lockdown: false,
  seal: { ok: true, signed: true, summary: 'ok', violations: [] },
  audit: { intact: true, records: 5, brokenAt: null },
  capabilities: 21, capabilityFingerprint: 'abc',
  providers: { notion: true, google: false, github: true },
  pendingApprovals: 0, indeterminate: 0,
  memory: { records: 0, sources: 0, authorizedSources: 0 },
  ...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'a', ref: 'REF', action: 'email.send', account: null, risk: 'high',
  summary: 'Send something', state: 'pending',
  requestedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z', binding: 'b',
  ...over,
});

test('an unconfigured shell says so instead of looking broken', () => {
  const c = describeConnection(null, null, false);
  assert.equal(c.state, 'unconfigured');
  assert.equal(c.operational, false);
  assert.match(c.detail, /jewel init/);
});

test('an offline runtime never reads as "nothing to do"', () => {
  const c = describeConnection({ reachable: false }, null, true);
  assert.equal(c.state, 'offline');
  assert.equal(c.operational, false);
  assert.match(c.detail, /Nothing shown here is live/);
});

test('lockdown outranks mode', () => {
  const c = describeConnection({ reachable: true, lockdown: true }, status({ mode: 'live', lockdown: true }), true);
  assert.equal(c.state, 'lockdown');
  assert.equal(c.operational, false);
});

test('live and dry run are visibly different', () => {
  const live = describeConnection({ reachable: true }, status({ mode: 'live' }), true);
  const dry = describeConnection({ reachable: true }, status({ mode: 'dryrun' }), true);
  assert.equal(live.state, 'live');
  assert.equal(dry.state, 'dryrun');
  assert.match(dry.detail, /Nothing reaches the outside world/);
  assert.match(live.detail, /real effects/);
  assert.equal(live.operational && dry.operational, true);
});

test('a broken seal is never softened', () => {
  const s = describeSeal(status({ seal: { ok: false, signed: false, summary: 'broken', violations: [{ path: 'src/core/policy.js', reason: 'modified' }] } }));
  assert.equal(s.tone, 'bad');
  assert.equal(s.label, 'Broken');
  assert.match(s.detail, /policy\.js \(modified\)/);
});

test('an unsigned seal warns rather than passing as fine', () => {
  const s = describeSeal(status({ seal: { ok: true, signed: false, summary: 'x', violations: [] } }));
  assert.equal(s.tone, 'warn');
  assert.match(s.detail, /high-risk actions are disabled/);
});

test('unknown seal state is not reported as OK', () => {
  assert.equal(describeSeal(null).tone, 'warn');
});

test('sections map to their live feed', () => {
  assert.equal(feedFor('Approval Queue'), 'approvals');
  assert.equal(feedFor('Memory Vault'), 'memory');
  assert.equal(feedFor('GitHub'), 'repos');
  assert.equal(feedFor('Voice Profile'), 'none');
  assert.match(emptyMessage('memory'), /will not fill that gap/);
});

test('approvals surface by risk, then by soonest expiry', () => {
  const ordered = orderApprovals([
    approval({ ref: 'LOW', risk: 'low' }),
    approval({ ref: 'CRIT', risk: 'critical' }),
    approval({ ref: 'HIGH2', risk: 'high', expiresAt: '2026-01-03T00:00:00Z' }),
    approval({ ref: 'HIGH1', risk: 'high', expiresAt: '2026-01-02T00:00:00Z' }),
  ]);
  assert.deepEqual(ordered.map((a) => a.ref), ['CRIT', 'HIGH1', 'HIGH2', 'LOW']);
});

test('expiry is phrased for a person, and lapsed is stated plainly', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(expiresIn(approval({ expiresAt: '2026-01-01T00:30:00Z' }), now), '30m left');
  assert.equal(expiresIn(approval({ expiresAt: '2026-01-01T05:00:00Z' }), now), '5h left');
  assert.equal(expiresIn(approval({ expiresAt: '2026-01-04T00:00:00Z' }), now), '3d left');
  assert.equal(expiresIn(approval({ expiresAt: '2025-12-31T00:00:00Z' }), now), 'expired');
});

test('uncitable records are identified so the UI can mark them', () => {
  const records = [
    { citable: true, subject: 'verified' },
    { citable: false, subject: 'unverified' },
  ] as MemoryRecord[];
  assert.deepEqual(uncitable(records).map((r) => r.subject), ['unverified']);
});

test('local chrome commands never need the runtime', () => {
  const offline = describeConnection({ reachable: false }, null, true);
  assert.deepEqual(routeCommand('focus mode', true, offline), { kind: 'local' });
});

test('a real request is blocked with the reason when the runtime cannot act', () => {
  const offline = describeConnection({ reachable: false }, null, true);
  const route = routeCommand('draft a reply to the client', false, offline);
  assert.equal(route.kind, 'blocked');
  assert.match((route as { reason: string }).reason, /npm run serve/);
});

test('a real request goes to Jewel when she can act', () => {
  const ok = describeConnection({ reachable: true }, status(), true);
  assert.deepEqual(routeCommand('  draft a reply  ', false, ok), { kind: 'ask', request: 'draft a reply' });
});

test('an empty command is refused before anything happens', () => {
  const ok = describeConnection({ reachable: true }, status(), true);
  assert.equal(routeCommand('   ', false, ok).kind, 'blocked');
});

const turn = (over: Partial<TurnResult> = {}): TurnResult => ({
  answer: 'Here is the draft.', trace: 't1', steps: 2,
  actions: [], awaitingApproval: [], warnings: [], truncated: false, ...over,
});

test('a pending approval is never described as done', () => {
  const d = describeTurn(turn({ awaitingApproval: [{ id: 'a', ref: 'R', summary: 's' }] }));
  assert.equal(d.tone, 'waiting');
  assert.match(d.notice, /Nothing was sent/);
  assert.equal(d.awaiting, 1);
});

test('failed actions are surfaced, not buried under the answer', () => {
  const d = describeTurn(turn({ actions: [{ name: 'email.send', status: 'failed', message: 'SMTP refused' }] }));
  assert.equal(d.tone, 'warn');
  assert.match(d.notice, /did not go through/);
  assert.match(d.notice, /email\.send/);
});

test('a clean turn carries no invented warning', () => {
  const d = describeTurn(turn());
  assert.equal(d.tone, 'ok');
  assert.equal(d.notice, '');
});

test('truncation is reported rather than passed off as a complete answer', () => {
  assert.match(describeTurn(turn({ truncated: true })).notice, /stopped at the limit/);
});

test('errors are translated into something a person can act on', () => {
  assert.match(describeError(new JewelUnreachable(new Error('x'))), /npm run serve/);
  assert.match(describeError(new JewelApiError('UNAUTHENTICATED', 'no', 401)), /VITE_JEWEL_API_TOKEN/);
  assert.match(describeError(new JewelApiError('SEAL_VIOLATION', 'no', 503)), /lockdown/);
  assert.match(describeError({}), /could not say what/);
});
