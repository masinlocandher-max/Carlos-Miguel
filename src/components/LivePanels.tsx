/**
 * Jewel OS - live panels.
 *
 * Renders real runtime state. The rule throughout: an absence must never look
 * like an answer. Three distinct renderings, never collapsed into one:
 *
 *   loading      Jewel is being asked
 *   unavailable  Jewel could not be asked, and why
 *   empty        Jewel was asked and there is genuinely nothing
 */
import { useEffect, useState } from 'react';
import { ShieldCheck, ListChecks, Database, AlertTriangle, Check, X, Lock } from 'lucide-react';
import type { Approval, Task, MemoryRecord } from '../lib/jewel.ts';
import type { FeedState, Connection } from '../lib/runtime.ts';
import { describeSeal, expiresIn, describeError } from '../lib/runtime.ts';
import type { Runtime } from '../lib/useJewel.ts';

/** One shared shell so every feed reports its state the same way. */
function Feed<T>({ state, children }: { state: FeedState<T>; children: (items: T[]) => React.ReactNode }) {
  if (state.kind === 'loading') return <p className="empty-line">Asking Jewel…</p>;
  if (state.kind === 'unavailable') {
    return (
      <p className="empty-line" role="status">
        <AlertTriangle size={14} /> {state.reason}
      </p>
    );
  }
  if (state.kind === 'empty') return <p className="empty-line">{state.message}</p>;
  return <>{children(state.items)}</>;
}

/** Connection and seal, always visible. Neither is ever softened. */
export function RuntimeStrip({ runtime }: { runtime: Runtime }) {
  const { connection, status } = runtime;
  const seal = describeSeal(status);

  return (
    <section className="glass panel runtime-strip">
      <div className="panel-heading">
        <span>
          <Lock size={16} /> Runtime
        </span>
        <span className="micro" data-connection={connection.state}>
          {connection.label}
        </span>
      </div>
      <p className="empty-line">{connection.detail}</p>
      <dl className="runtime-facts">
        <div>
          <dt>Seal</dt>
          <dd data-tone={seal.tone}>{seal.label}</dd>
        </div>
        <div>
          <dt>Audit</dt>
          <dd data-tone={status?.audit.intact === false ? 'bad' : 'ok'}>
            {status ? (status.audit.intact ? `${status.audit.records} records, intact` : `BROKEN at ${status.audit.brokenAt}`) : '—'}
          </dd>
        </div>
        <div>
          <dt>Capabilities</dt>
          <dd>{status ? status.capabilities : '—'}</dd>
        </div>
      </dl>
      {seal.tone !== 'ok' && <p className="preview-note">{seal.detail}</p>}
      {status && status.indeterminate > 0 && (
        <p className="preview-note" role="alert">
          {status.indeterminate} action(s) started but never reported a result. Jewel will not retry on her own.
        </p>
      )}
    </section>
  );
}

/** The approval queue: the one place FMB decides. */
export function ApprovalsPanel({ runtime, compact = false }: { runtime: Runtime; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const decide = async (ref: string, verb: 'grant' | 'deny') => {
    setBusy(ref);
    setError('');
    try {
      if (verb === 'grant') await runtime.grant(ref);
      else await runtime.deny(ref);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="glass panel">
      <div className="panel-heading">
        <span>
          <ShieldCheck size={16} /> Approvals
        </span>
        <span className="micro">{runtime.approvals.kind === 'ready' ? runtime.approvals.items.length : ''}</span>
      </div>

      <Feed state={runtime.approvals}>
        {(items: Approval[]) => (
          <ul className="approval-list">
            {(compact ? items.slice(0, 3) : items).map((a) => (
              <li key={a.id} className="approval-item" data-risk={a.risk}>
                <div className="approval-summary">
                  <strong>{a.summary}</strong>
                  <small>
                    {a.ref} · {a.risk}
                    {a.account ? ` · ${a.account}` : ''} · {expiresIn(a)}
                  </small>
                </div>
                {!compact && (
                  <div className="approval-actions">
                    <button
                      className="outline-button"
                      disabled={busy === a.ref}
                      onClick={() => decide(a.ref, 'grant')}
                      aria-label={`Approve ${a.summary}`}
                    >
                      <Check size={15} /> Approve
                    </button>
                    <button
                      className="text-button"
                      disabled={busy === a.ref}
                      onClick={() => decide(a.ref, 'deny')}
                      aria-label={`Deny ${a.summary}`}
                    >
                      <X size={15} /> Deny
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Feed>

      {error && (
        <p className="empty-line" role="alert">
          {error}
        </p>
      )}
      {!compact && (
        <p className="preview-note">
          Approving unlocks this exact payload once. Editing anything invalidates it.
        </p>
      )}
    </section>
  );
}

export function TasksPanel({ runtime }: { runtime: Runtime }) {
  return (
    <section className="glass panel">
      <div className="panel-heading">
        <span>
          <ListChecks size={16} /> Open tasks
        </span>
      </div>
      <Feed state={runtime.tasks}>
        {(items: Task[]) => (
          <ul className="task-list">
            {items.map((t) => (
              <li key={t.id} data-priority={t.priority}>
                <strong>{t.title}</strong>
                <small>
                  {t.project ?? 'No project'}
                  {t.due ? ` · due ${new Date(t.due).toLocaleDateString('en', { month: 'short', day: 'numeric' })}` : ''}
                </small>
              </li>
            ))}
          </ul>
        )}
      </Feed>
    </section>
  );
}

/** Memory, with citability shown rather than implied. */
export function MemoryPanel({ runtime }: { runtime: Runtime }) {
  const [query, setQuery] = useState('');
  const [feed, setFeed] = useState<FeedState<MemoryRecord>>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const id = window.setTimeout(async () => {
      const next = await runtime.searchMemory(query);
      if (!cancelled) setFeed(next);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [query, runtime]);

  return (
    <section className="glass panel">
      <div className="panel-heading">
        <span>
          <Database size={16} /> Memory
        </span>
      </div>
      <input
        className="memory-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search memory"
        aria-label="Search memory"
      />
      <Feed state={feed}>
        {(items: MemoryRecord[]) => (
          <ul className="memory-list">
            {items.map((r) => (
              <li key={r.id} data-citable={r.citable}>
                <strong>{r.subject}</strong>
                <small>
                  {r.citable ? 'verified' : 'unverified — not a fact'} · {r.source}
                </small>
              </li>
            ))}
          </ul>
        )}
      </Feed>
      <p className="preview-note">
        Unverified records are shown but must not be treated as established fact.
      </p>
    </section>
  );
}

/** A short, honest line for a section with no live source yet. */
export function NotWired({ connection }: { connection: Connection }) {
  return (
    <p className="empty-line">
      {connection.operational
        ? 'No live source is wired to this section yet.'
        : connection.detail}
    </p>
  );
}
