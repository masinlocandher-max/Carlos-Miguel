/**
 * Jewel OS - interface logic for the command centre.
 *
 * Pure functions only. Every decision the shell makes about what to show and
 * what to say lives here, so it can be tested without a browser or a renderer.
 * The React hook in `useJewel.ts` is deliberately thin around this.
 *
 * The guiding rule is the same one the runtime follows: never let an absence
 * look like an answer. A disconnected runtime, an empty result and a withheld
 * record must each read differently on screen.
 */
import type { Section } from './model.ts';
import type { Status, Approval, TurnResult, MemoryRecord, ExecutionStatus } from './jewel.ts';
import { statusLabel } from './jewel.ts';

export type ConnectionState = 'connecting' | 'offline' | 'unconfigured' | 'lockdown' | 'dryrun' | 'live';

export type Connection = {
  state: ConnectionState;
  /** One short line for the status strip. Written to be read, not parsed. */
  label: string;
  /** Longer explanation, shown when the state needs action from FMB. */
  detail: string;
  /** True when Jewel can actually do something right now. */
  operational: boolean;
};

/**
 * Turn liveness plus status into something honest for the screen.
 * Order matters: the most blocking condition wins.
 */
export function describeConnection(
  health: { reachable: boolean; lockdown?: boolean } | null,
  status: Status | null,
  configured: boolean,
): Connection {
  if (!configured) {
    return {
      state: 'unconfigured',
      label: 'Not configured',
      detail: 'No API token. Run `jewel init`, then restart the command centre so it picks up VITE_JEWEL_API_TOKEN.',
      operational: false,
    };
  }
  if (health === null) {
    return { state: 'connecting', label: 'Connecting', detail: 'Reaching Jewel’s runtime.', operational: false };
  }
  if (!health.reachable) {
    return {
      state: 'offline',
      label: 'Runtime offline',
      detail: 'Jewel’s runtime is not running. Start it with `npm run serve`. Nothing shown here is live.',
      operational: false,
    };
  }
  if (health.lockdown || status?.lockdown) {
    return {
      state: 'lockdown',
      label: 'Lockdown',
      detail: 'The capability seal does not verify, so only diagnostics run. Re-seal the core before Jewel can act.',
      operational: false,
    };
  }
  if (status?.mode === 'live') {
    return {
      state: 'live',
      label: 'Live',
      detail: 'Actions have real effects. Everything still needs your approval.',
      operational: true,
    };
  }
  return {
    state: 'dryrun',
    label: 'Dry run',
    detail: 'Nothing reaches the outside world. Set JEWEL_EXECUTION_MODE=live when you are ready.',
    operational: true,
  };
}

/** What the seal strip should say, without softening a broken one. */
export function describeSeal(status: Status | null): { label: string; tone: 'ok' | 'warn' | 'bad'; detail: string } {
  if (!status) return { label: 'Unknown', tone: 'warn', detail: 'Seal state is unavailable while the runtime is unreachable.' };
  if (!status.seal.ok) {
    const which = status.seal.violations.map((v) => `${v.path} (${v.reason})`).join(', ');
    return { label: 'Broken', tone: 'bad', detail: which || status.seal.summary };
  }
  if (!status.seal.signed) {
    return { label: 'Unsigned', tone: 'warn', detail: 'Hashes verify but the core is not owner-signed, so high-risk actions are disabled.' };
  }
  return { label: 'Signed', tone: 'ok', detail: 'Capability seal verified and owner-signed.' };
}

/** Which live data a section needs. Sections not listed have no live source. */
export type SectionFeed = 'approvals' | 'tasks' | 'memory' | 'repos' | 'status' | 'none';

export function feedFor(section: Section): SectionFeed {
  switch (section) {
    case 'Approval Queue': return 'approvals';
    case 'Tasks & Approvals': return 'tasks';
    case 'Memory Vault': return 'memory';
    case 'GitHub': return 'repos';
    case 'Home / Command Center': return 'status';
    default: return 'none';
  }
}

/**
 * Distinguish "nothing to show" from "could not look".
 * The shell must never render an empty list that implies all-clear when the
 * truth is that it never managed to ask.
 */
export type FeedState<T> =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'empty'; message: string }
  | { kind: 'ready'; items: T[] };

export function emptyMessage(feed: SectionFeed): string {
  switch (feed) {
    case 'approvals': return 'Nothing waiting on you.';
    case 'tasks': return 'No open tasks.';
    case 'memory': return 'Nothing in memory matched. Jewel will not fill that gap with a guess.';
    case 'repos': return 'No repositories visible to Jewel.';
    default: return 'Nothing to show.';
  }
}

/** Sort approvals so the most consequential and soonest-expiring surface first. */
const RISK_WEIGHT: Record<Approval['risk'], number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

export function orderApprovals(approvals: Approval[]): Approval[] {
  return [...approvals].sort(
    (a, b) => RISK_WEIGHT[a.risk] - RISK_WEIGHT[b.risk] || a.expiresAt.localeCompare(b.expiresAt),
  );
}

/** How long until an approval lapses, phrased for a person. */
export function expiresIn(approval: Approval, now = Date.now()): string {
  const ms = Date.parse(approval.expiresAt) - now;
  if (Number.isNaN(ms)) return 'unknown';
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

/** Memory records that must not be presented as fact. */
export function uncitable(records: MemoryRecord[]): MemoryRecord[] {
  return records.filter((r) => !r.citable);
}

/**
 * Decide whether a typed command is local chrome or real work for Jewel.
 * Local intents stay instant and offline; everything else is a real request.
 */
export type Route =
  | { kind: 'local' }
  | { kind: 'ask'; request: string }
  | { kind: 'blocked'; reason: string };

export function routeCommand(input: string, isLocalIntent: boolean, connection: Connection): Route {
  const request = input.trim();
  if (!request) return { kind: 'blocked', reason: 'Type something first.' };
  if (isLocalIntent) return { kind: 'local' };

  if (!connection.operational) {
    return { kind: 'blocked', reason: connection.detail };
  }
  return { kind: 'ask', request };
}

/** Turn an agent result into what the screen should say and show. */
export function describeTurn(turn: TurnResult): {
  answer: string;
  notice: string;
  awaiting: number;
  tone: 'ok' | 'waiting' | 'warn';
} {
  const awaiting = turn.awaitingApproval.length;
  const failed = turn.actions.filter((a) => a.status === 'failed' || a.status === 'denied' || a.status === 'refused');

  let notice = '';
  let tone: 'ok' | 'waiting' | 'warn' = 'ok';

  if (awaiting > 0) {
    tone = 'waiting';
    notice = awaiting === 1
      ? 'Nothing was sent. One action is waiting on your approval.'
      : `Nothing was sent. ${awaiting} actions are waiting on your approval.`;
  } else if (failed.length > 0) {
    tone = 'warn';
    notice = `${failed.length} action(s) did not go through: ${failed.map((f) => `${f.name} — ${statusLabel[f.status]}`).join('; ')}`;
  } else if (turn.truncated) {
    tone = 'warn';
    notice = 'Jewel stopped at the limit for one turn. Ask again to continue.';
  } else if (turn.warnings.length) {
    tone = 'warn';
    notice = turn.warnings[0];
  }

  return { answer: turn.answer, notice, awaiting, tone };
}

/** Per-action line for the activity list. */
export function actionLine(action: { name: string; status: ExecutionStatus; message: string }): string {
  return `${statusLabel[action.status]} · ${action.name}`;
}

/** Turn any thrown value into something safe and useful to show a person. */
export function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; code?: string };
    if (e.name === 'JewelUnreachable') return 'Jewel’s runtime is not running. Start it with `npm run serve`.';
    if (e.code === 'UNAUTHENTICATED') return 'The command centre’s token was rejected. Check VITE_JEWEL_API_TOKEN matches JEWEL_API_TOKEN.';
    if (e.code === 'SEAL_VIOLATION') return 'The capability seal does not verify. Jewel is in lockdown.';
    if (e.message) return e.message;
  }
  return 'Something went wrong and Jewel could not say what. Check the runtime log.';
}
