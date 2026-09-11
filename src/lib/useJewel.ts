/**
 * Jewel OS - React binding for the runtime.
 *
 * Deliberately thin. Every decision about what to show lives in `runtime.ts`
 * as pure functions, which is where the tests are. This file handles only the
 * things React owns: effects, intervals, cleanup and stale-response guarding.
 *
 * Two rules it never breaks:
 *   - a request that resolves after the component moved on is DISCARDED, so a
 *     slow response can never overwrite fresher state;
 *   - a failed fetch sets an explicit `unavailable` state, never an empty
 *     list. On screen, "could not look" must not resemble "nothing there".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JewelClient } from './jewel.ts';
import type { Status, Approval, Task, MemoryRecord, TurnResult, CallResult } from './jewel.ts';
import { describeConnection, describeError, orderApprovals } from './runtime.ts';
import type { Connection, FeedState } from './runtime.ts';

const STATUS_POLL_MS = 10_000;

export type Runtime = {
  client: JewelClient;
  connection: Connection;
  status: Status | null;
  approvals: FeedState<Approval>;
  tasks: FeedState<Task>;
  refresh: () => void;
  ask: (request: string) => Promise<TurnResult>;
  grant: (ref: string) => Promise<void>;
  deny: (ref: string, reason?: string) => Promise<void>;
  searchMemory: (query: string) => Promise<FeedState<MemoryRecord>>;
  call: (tool: string, args?: Record<string, unknown>) => Promise<CallResult>;
};

export function useJewel(options: { baseUrl?: string; token?: string } = {}): Runtime {
  const client = useMemo(() => new JewelClient(options), [options.baseUrl, options.token]);

  const [health, setHealth] = useState<{ reachable: boolean; lockdown?: boolean } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [approvals, setApprovals] = useState<FeedState<Approval>>({ kind: 'loading' });
  const [tasks, setTasks] = useState<FeedState<Task>>({ kind: 'loading' });
  const [tick, setTick] = useState(0);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Liveness and status, polled. Everything else hangs off this.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const h = await client.health();
      if (cancelled || !alive.current) return;
      setHealth(h);

      if (!h.reachable || !client.configured) {
        setStatus(null);
        setApprovals({ kind: 'unavailable', reason: 'Jewel’s runtime is not reachable.' });
        setTasks({ kind: 'unavailable', reason: 'Jewel’s runtime is not reachable.' });
        return;
      }

      try {
        const s = await client.status();
        if (cancelled || !alive.current) return;
        setStatus(s);
      } catch (err) {
        if (cancelled || !alive.current) return;
        setStatus(null);
        setApprovals({ kind: 'unavailable', reason: describeError(err) });
        setTasks({ kind: 'unavailable', reason: describeError(err) });
        return;
      }

      try {
        const list = await client.approvals('pending');
        if (cancelled || !alive.current) return;
        setApprovals(list.length
          ? { kind: 'ready', items: orderApprovals(list) }
          : { kind: 'empty', message: 'Nothing waiting on you.' });
      } catch (err) {
        if (!cancelled && alive.current) setApprovals({ kind: 'unavailable', reason: describeError(err) });
      }

      try {
        const list = await client.tasks('open');
        if (cancelled || !alive.current) return;
        setTasks(list.length
          ? { kind: 'ready', items: list }
          : { kind: 'empty', message: 'No open tasks.' });
      } catch (err) {
        if (!cancelled && alive.current) setTasks({ kind: 'unavailable', reason: describeError(err) });
      }
    };

    void load();
    const timer = window.setInterval(load, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client, tick]);

  const connection = useMemo(
    () => describeConnection(health, status, client.configured),
    [health, status, client.configured],
  );

  const ask = useCallback(async (request: string) => {
    const turn = await client.ask(request);
    refresh();          // a turn may have raised an approval
    return turn;
  }, [client, refresh]);

  const grant = useCallback(async (ref: string) => { await client.grant(ref); refresh(); }, [client, refresh]);
  const deny = useCallback(async (ref: string, reason?: string) => { await client.deny(ref, reason); refresh(); }, [client, refresh]);

  const call = useCallback(async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.call(tool, args);
    refresh();
    return result;
  }, [client, refresh]);

  const searchMemory = useCallback(async (query: string): Promise<FeedState<MemoryRecord>> => {
    try {
      const { records } = await client.memory(query);
      return records.length
        ? { kind: 'ready', items: records }
        : { kind: 'empty', message: 'Nothing in memory matched. Jewel will not fill that gap with a guess.' };
    } catch (err) {
      return { kind: 'unavailable', reason: describeError(err) };
    }
  }, [client]);

  return { client, connection, status, approvals, tasks, refresh, ask, grant, deny, searchMemory, call };
}
