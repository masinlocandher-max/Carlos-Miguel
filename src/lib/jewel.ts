/**
 * Jewel OS - typed client for the local control API.
 *
 * This is the bridge the command centre was missing. Codex's shell shipped with
 * `parseCommand`, described in its own source as "a narrow local command router,
 * not a model or a provider action executor". It could navigate and nothing
 * more. This client lets it read real state and ask Jewel to act — while adding
 * no authority of its own: every call lands on the same policy, approval,
 * idempotency and audit path the CLI uses.
 *
 * Design rules for this file:
 *   - never throw for an expected state. `pending_approval` is a normal
 *     outcome, not an error, and the UI must be able to render it calmly.
 *   - never assume the runtime is there. If the API is down the shell says so
 *     honestly instead of showing an empty dashboard that looks like "nothing
 *     to do" (the same reason unconfigured providers throw in the runtime).
 *   - no secrets in this file. The token comes from the environment at build
 *     time or from the operator, never hard-coded.
 */

export type ExecutionMode = 'dryrun' | 'live';

export type SealState = {
  ok: boolean;
  signed: boolean;
  summary: string;
  violations: { path: string; reason: string }[];
};

export type Status = {
  owner: string;
  mode: ExecutionMode;
  lockdown: boolean;
  seal: SealState;
  audit: { intact: boolean; records: number; brokenAt: number | null };
  capabilities: number;
  capabilityFingerprint: string;
  providers: { notion: boolean; google: boolean; github: boolean };
  pendingApprovals: number;
  indeterminate: number;
  memory: { records: number; sources: number; authorizedSources: number };
};

export type Approval = {
  id: string;
  ref: string;
  action: string;
  account: string | null;
  risk: 'none' | 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  state: 'pending' | 'granted' | 'denied' | 'expired' | 'consumed' | 'revoked' | 'invalidated';
  requestedAt: string;
  expiresAt: string;
  binding: string;
};

export type MemoryRecord = {
  id: string;
  subject: string;
  content: unknown;
  kind: string;
  project: string | null;
  verification: 'verified' | 'unverified' | 'conflicted' | 'stale' | 'revoked';
  source: string;
  retrievedAt: string;
  /** False means: do not present this as established fact. */
  citable: boolean;
};

export type Task = {
  id: string;
  title: string;
  project: string | null;
  due: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'done' | 'blocked';
  notes: string;
};

export type ExecutionStatus =
  | 'succeeded' | 'failed' | 'partial' | 'deduped'
  | 'pending_approval' | 'denied' | 'refused' | 'simulated';

export type CallResult = {
  status: ExecutionStatus;
  executionId: string;
  correlationId: string;
  message: string;
  result?: unknown;
  error?: { code: string; message: string };
  approval?: { id: string; ref: string; summary: string; expiresAt: string };
};

export type TurnResult = {
  answer: string;
  trace: string;
  steps: number;
  actions: { name: string; status: ExecutionStatus; message: string }[];
  awaitingApproval: { id: string; ref: string; summary: string }[];
  warnings: string[];
  truncated: boolean;
};

/** A failure that is about reaching Jewel, not about what she decided. */
export class JewelUnreachable extends Error {
  constructor(cause: unknown) {
    super('Jewel’s runtime is not reachable. Start it with `npm run serve`.');
    this.name = 'JewelUnreachable';
    this.cause = cause;
  }
}

/** A typed error the runtime returned on purpose. */
export class JewelApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'JewelApiError';
    this.code = code;
    this.status = status;
  }
}

export type ClientOptions = {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
};

export class JewelClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? readEnv('VITE_JEWEL_API_URL') ?? 'http://127.0.0.1:7777').replace(/\/+$/, '');
    this.token = opts.token ?? readEnv('VITE_JEWEL_API_TOKEN') ?? '';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  get configured(): boolean {
    return this.token.length > 0;
  }

  /**
   * Liveness. Never throws — the shell needs to render an honest disconnected
   * state, and a thrown error at startup would blank the interface.
   */
  async health(): Promise<{ reachable: boolean; lockdown?: boolean; sealed?: boolean; signed?: boolean }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`);
      if (!res.ok) return { reachable: false };
      return { reachable: true, ...(await res.json()) };
    } catch {
      return { reachable: false };
    }
  }

  status(): Promise<Status> { return this.get<Status>('/status'); }

  capabilities(): Promise<{ capabilities: { name: string; description: string; risk: string; requiresApproval: boolean }[]; fingerprint: string }> {
    return this.get('/capabilities');
  }

  async approvals(state: 'pending' | 'granted' | 'all' = 'pending'): Promise<Approval[]> {
    const { approvals } = await this.get<{ approvals: Approval[] }>(`/approvals?state=${encodeURIComponent(state)}`);
    return approvals;
  }

  async tasks(status: 'open' | 'done' | 'blocked' | 'all' = 'open'): Promise<Task[]> {
    const { tasks } = await this.get<{ tasks: Task[] }>(`/tasks?status=${encodeURIComponent(status)}`);
    return tasks;
  }

  async memory(query = ''): Promise<{ records: MemoryRecord[]; withheld: number }> {
    return this.get(`/memory?q=${encodeURIComponent(query)}`);
  }

  audit(trace?: string): Promise<unknown> {
    return this.get(trace ? `/audit?trace=${encodeURIComponent(trace)}` : '/audit');
  }

  /** One full agent turn. */
  ask(request: string): Promise<TurnResult> {
    return this.post<TurnResult>('/ask', { request });
  }

  /**
   * Invoke one capability directly. A `pending_approval` result is a normal
   * outcome, not a failure — render it as something waiting on FMB.
   */
  call(tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    return this.post<CallResult>('/call', { tool, args });
  }

  grant(ref: string, note?: string): Promise<Approval> {
    return this.post<Approval>('/approvals/grant', { ref, note });
  }

  deny(ref: string, reason?: string): Promise<Approval> {
    return this.post<Approval>('/approvals/deny', { ref, reason });
  }

  // --- internals ---------------------------------------------------------

  private async get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }

  private async post<T>(path: string, body: unknown): Promise<T> { return this.request<T>('POST', path, body); }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new JewelUnreachable(cause);
    }

    const text = await res.text();
    let payload: unknown = null;
    if (text) { try { payload = JSON.parse(text); } catch { payload = { raw: text }; } }

    if (!res.ok) {
      const err = (payload as { error?: { code?: string; message?: string } })?.error;
      throw new JewelApiError(err?.code ?? 'HTTP_ERROR', err?.message ?? `Jewel returned HTTP ${res.status}.`, res.status);
    }
    return payload as T;
  }
}

/** Read a build-time variable without assuming Vite, Node or a browser. */
function readEnv(name: string): string | undefined {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string> }).env;
  if (viteEnv?.[name]) return viteEnv[name];
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process;
  return proc?.env?.[name];
}

/** Human-readable, calm phrasing for each execution status. */
export const statusLabel: Record<ExecutionStatus, string> = {
  succeeded: 'Done',
  simulated: 'Dry run only',
  partial: 'Partly done',
  deduped: 'Already done',
  pending_approval: 'Waiting on you',
  denied: 'Not permitted',
  refused: 'Jewel will not do this',
  failed: 'Failed',
};
