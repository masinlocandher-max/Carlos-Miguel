/**
 * Jewel OS - built-in capability set.
 *
 * Every tool declares its own risk, gate and schema. The executor enforces
 * them; nothing here checks its own permission, which is why a tool cannot
 * forget to.
 *
 * Gating follows AGENTS.md exactly:
 *   drafting is free, sending is gated;
 *   reading is authorized, writing to the outside world is approved;
 *   deleting anything is approved, always.
 */
import { RISK } from '../core/constitution.js';
import { object, str, arr, int, bool } from '../core/schema.js';
import { KIND, SENSITIVITY } from '../core/memory.js';
import { ProviderError } from '../core/errors.js';

/**
 * @param {{ memory:object, approvals:object, audit:object, workspace:object,
 *           tasks:object, seal:object, ledger:object, registry:object }} deps
 * @returns {object[]} tool definitions
 */
export function builtinTools(deps) {
  const { memory, approvals, audit, workspace, tasks, seal, ledger } = deps;

  return [
    // ---- Diagnostics (survive seal lockdown) ---------------------------
    {
      name: 'system.doctor',
      description: 'Report Jewel\'s health: capability seal, audit chain integrity, connected providers, pending approvals and unresolved actions.',
      risk: RISK.NONE, diagnostic: true,
      input: object({}),
      run: async () => ({
        seal: { ok: seal.ok, signed: seal.signed, summary: seal.summary, violations: seal.violations },
        auditChain: audit.verifyChain(),
        auditRecords: audit.length,
        providers: {
          notion: workspace.notion.configured,
          google: workspace.google.configured,
          github: workspace.github.configured,
        },
        pendingApprovals: approvals.pending().length,
        indeterminateActions: ledger.indeterminate(),
        memory: memory.stats(),
      }),
    },
    {
      name: 'system.verify_audit',
      description: 'Verify the audit chain end to end and report the exact record where it diverges, if any.',
      risk: RISK.NONE, diagnostic: true,
      input: object({}),
      run: async () => audit.verifyChain(),
    },

    // ---- Memory ---------------------------------------------------------
    {
      name: 'memory.search',
      description: 'Search Jewel\'s memory. Returns records with provenance and a citable flag. Unverified records must not be stated as fact.',
      risk: RISK.LOW,
      input: object({
        query: str({ maxLength: 300, default: '' }),
        kind: str({ enum: Object.values(KIND), optional: true, nullable: true }),
        project: str({ optional: true, nullable: true }),
        includeStale: bool({ default: false }),
        limit: int({ minimum: 1, maximum: 50, default: 10 }),
      }),
      run: async (a, ctx) => {
        const out = memory.search(a, { ...ctx.principal, clearance: ctx.principal?.clearance ?? SENSITIVITY.RESTRICTED });
        return { records: memory.toContext(out.results), withheld: out.withheld, conflicts: out.conflicts };
      },
    },
    {
      name: 'memory.remember',
      description: 'Store a fact, preference, decision or note with its source. Jewel does not store unsourced knowledge.',
      risk: RISK.LOW,
      input: object({
        kind: str({ enum: Object.values(KIND) }),
        subject: str({ minLength: 1, maxLength: 300 }),
        content: str({ maxLength: 20000 }),
        sourceId: str({ minLength: 1 }),
        sourceRevision: str({ optional: true, nullable: true }),
        project: str({ optional: true, nullable: true }),
        sensitivity: str({ enum: Object.values(SENSITIVITY), default: SENSITIVITY.PRIVATE }),
        tags: arr(str(), { default: [] }),
      }),
      run: async (a) => {
        const rec = memory.remember({
          kind: a.kind, subject: a.subject, content: a.content, project: a.project,
          sensitivity: a.sensitivity, tags: a.tags,
          provenance: { sourceId: a.sourceId, sourceRevision: a.sourceRevision },
        });
        return { id: rec.id, verification: rec.verification, note: 'Stored as unverified. Confirm it against the source to make it citable.' };
      },
    },
    {
      name: 'memory.register_source',
      description: 'Authorize a knowledge source so records from it can be stored and retrieved.',
      risk: RISK.LOW,
      input: object({
        id: str({ minLength: 1 }), type: str({ minLength: 1 }), label: str({ minLength: 1 }),
        sensitivity: str({ enum: Object.values(SENSITIVITY), default: SENSITIVITY.PRIVATE }),
      }),
      run: async (a) => memory.registerSource(a),
    },
    {
      name: 'memory.revoke_source',
      description: 'Withdraw a source\'s authorization. Purges every record derived from it and leaves an audit tombstone.',
      risk: RISK.HIGH, gate: 'file.delete', sideEffect: false,
      summarize: (a) => `Revoke source ${a.sourceId} and purge its records`,
      input: object({ sourceId: str({ minLength: 1 }), reason: str({ default: 'permission-withdrawn' }) }),
      run: async (a) => memory.revokeSource(a.sourceId, a.reason),
    },

    // ---- Tasks and approvals -------------------------------------------
    {
      name: 'task.create',
      description: 'Create a task with a project, owner and due date. Internal only - creates no external commitment.',
      risk: RISK.LOW,
      input: object({
        title: str({ minLength: 1, maxLength: 300 }),
        project: str({ optional: true, nullable: true }),
        due: str({ format: 'date-time', optional: true, nullable: true }),
        priority: str({ enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' }),
        notes: str({ default: '' }),
      }),
      run: async (a) => tasks.create(a),
    },
    {
      name: 'task.list',
      description: 'List tasks, optionally filtered by project or status.',
      risk: RISK.NONE,
      input: object({
        status: str({ enum: ['open', 'done', 'blocked', 'all'], default: 'open' }),
        project: str({ optional: true, nullable: true }),
      }),
      run: async (a) => tasks.list(a),
    },
    {
      name: 'task.update',
      description: 'Update a task\'s status or notes.',
      risk: RISK.LOW,
      input: object({
        id: str({ minLength: 1 }),
        status: str({ enum: ['open', 'done', 'blocked'], optional: true, nullable: true }),
        notes: str({ optional: true, nullable: true }),
      }),
      run: async (a) => tasks.update(a.id, a),
    },
    {
      name: 'approval.list',
      description: 'List approvals waiting on FMB, with the exact action each one unlocks.',
      risk: RISK.NONE,
      input: object({ state: str({ default: 'pending' }) }),
      run: async (a) => approvals.list(a.state === 'all' ? undefined : a.state)
        .map((r) => ({ id: r.id, ref: r.ref, action: r.action, summary: r.summary, risk: r.risk, state: r.state, expiresAt: r.expiresAt })),
    },

    // ---- Notion ---------------------------------------------------------
    {
      name: 'notion.search',
      description: 'Search the Notion workspace - the source of truth for projects, tasks, brand rules and file registry.',
      risk: RISK.MEDIUM, scope: 'notion',
      input: object({ query: str({ minLength: 1, maxLength: 200 }), limit: int({ minimum: 1, maximum: 25, default: 10 }) }),
      run: async (a) => ({ results: await workspace.notion.search({ query: a.query, pageSize: a.limit }) }),
    },
    {
      name: 'notion.read_page',
      description: 'Read one Notion page with its revision, so the content can be cited.',
      risk: RISK.MEDIUM, scope: 'notion',
      input: object({ pageId: str({ minLength: 1 }) }),
      run: async (a) => workspace.notion.getPage(a.pageId),
    },

    // ---- Email: drafting is free, sending is gated ----------------------
    {
      name: 'email.search',
      description: 'Search FMB\'s authorized mailbox. Read only.',
      risk: RISK.MEDIUM, scope: 'email',
      input: object({ query: str({ default: '' }), limit: int({ minimum: 1, maximum: 25, default: 10 }) }),
      run: async (a) => ({ threads: await workspace.google.listThreads({ query: a.query, max: a.limit }) }),
    },
    {
      name: 'email.draft',
      description: 'Create an email draft for FMB to review. Creates a draft only - it does not send.',
      risk: RISK.MEDIUM, scope: 'email', sideEffect: true, gate: null,
      accountOf: (a) => a.from,
      input: object({
        from: str({ format: 'email' }),
        to: arr(str({ format: 'email' }), { minItems: 1, maxItems: 20 }),
        subject: str({ minLength: 1, maxLength: 300 }),
        body: str({ minLength: 1, maxLength: 50000 }),
      }),
      summarize: (a) => `Draft "${a.subject}" to ${a.to.join(', ')}`,
      simulate: async (a) => ({ simulated: true, wouldDraft: a.subject, to: a.to }),
      run: async (a) => workspace.google.createDraft(a),
    },
    {
      name: 'email.send',
      description: 'Send a reviewed draft. Always requires FMB\'s approval, bound to the exact draft.',
      risk: RISK.HIGH, gate: 'email.send', sideEffect: true, scope: 'email',
      accountOf: (a) => a.from,
      input: object({
        from: str({ format: 'email' }),
        draftId: str({ minLength: 1 }),
        to: arr(str({ format: 'email' }), { minItems: 1, maxItems: 20 }),
        subject: str({ minLength: 1, maxLength: 300 }),
        bodyHash: str({ minLength: 8, maxLength: 128 }),
      }),
      summarize: (a) => `SEND "${a.subject}" to ${a.to.join(', ')} from ${a.from}`,
      simulate: async (a) => ({ simulated: true, wouldSend: a.subject, to: a.to }),
      run: async (a) => workspace.google.sendDraft(a.draftId),
    },

    // ---- Calendar -------------------------------------------------------
    {
      name: 'calendar.list',
      description: 'List events in a time range from an authorized calendar.',
      risk: RISK.MEDIUM, scope: 'calendar',
      input: object({
        calendarId: str({ default: 'primary' }),
        timeMin: str({ format: 'date-time' }),
        timeMax: str({ format: 'date-time' }),
        limit: int({ minimum: 1, maximum: 50, default: 20 }),
      }),
      run: async (a) => ({ events: await workspace.google.listEvents({ ...a, max: a.limit }) }),
    },
    {
      name: 'calendar.check_availability',
      description: 'Check free/busy for a window. Run this immediately before proposing or writing any event.',
      risk: RISK.MEDIUM, scope: 'calendar',
      input: object({
        calendarId: str({ default: 'primary' }),
        timeMin: str({ format: 'date-time' }), timeMax: str({ format: 'date-time' }),
      }),
      run: async (a) => workspace.google.freeBusy(a),
    },

    {
      name: 'calendar.create_event',
      description: 'Create a calendar event. Always requires FMB\'s approval, and re-checks availability immediately before writing.',
      risk: RISK.HIGH, gate: 'calendar.write', sideEffect: true, scope: 'calendar',
      accountOf: (a) => a.calendarId,
      input: object({
        calendarId: str({ minLength: 1 }),
        summary: str({ minLength: 1, maxLength: 300 }),
        start: str({ format: 'date-time' }),
        end: str({ format: 'date-time' }),
        timezone: str({ minLength: 1 }),
        attendees: arr(str({ format: 'email' }), { default: [] }),
      }),
      summarize: (a) => `Create "${a.summary}" ${a.start} to ${a.end} (${a.timezone}) on ${a.calendarId} with ${a.attendees.length} attendee(s)`,
      simulate: async (a) => ({ simulated: true, wouldCreate: a.summary, start: a.start }),
      run: async (a) => {
        // Availability is re-checked HERE, at write time, not when the
        // approval was raised. A check from an hour ago is not a check.
        const availability = await workspace.google.freeBusy({
          calendarId: a.calendarId, timeMin: a.start, timeMax: a.end,
        });
        if (!availability.free) {
          throw new ProviderError(
            'That window is no longer free. Jewel did not create the event.',
            { conflicts: availability.busy, recheckedAt: availability.checkedAt },
          );
        }
        return workspace.google.createEvent(a);
      },
    },

    // ---- Drive ----------------------------------------------------------
    {
      name: 'drive.search',
      description: 'Find files in the Drive vault. Returns locators, never file contents.',
      risk: RISK.MEDIUM, scope: 'drive',
      input: object({ query: str({ minLength: 1 }), limit: int({ minimum: 1, maximum: 50, default: 10 }) }),
      run: async (a) => ({ files: await workspace.google.searchDrive({ query: a.query, max: a.limit }) }),
    },

    // ---- GitHub ---------------------------------------------------------
    {
      name: 'github.repos',
      description: 'List repositories Jewel can see, most recently pushed first.',
      risk: RISK.MEDIUM, scope: 'github',
      input: object({ limit: int({ minimum: 1, maximum: 50, default: 20 }) }),
      run: async (a) => ({ repos: await workspace.github.listRepos({ max: a.limit }) }),
    },
    {
      name: 'github.pulls',
      description: 'List pull requests for a repository.',
      risk: RISK.MEDIUM, scope: 'github',
      input: object({ owner: str({ minLength: 1 }), repo: str({ minLength: 1 }), state: str({ enum: ['open', 'closed', 'all'], default: 'open' }) }),
      run: async (a) => ({ pulls: await workspace.github.listPulls(a) }),
    },
  ];
}

/**
 * Task store. Local-first so Jewel keeps working when Notion is unreachable;
 * Notion remains the owner-visible source of truth.
 */
export class TaskStore {
  /** @param {{ table:object, clock:object, audit:object }} deps */
  constructor({ table, clock, audit }) { this.table = table; this.clock = clock; this.audit = audit; }

  create(input) {
    const id = `tsk_${this.clock.ms().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const rec = {
      id, version: 0, title: input.title, project: input.project ?? null,
      due: input.due ?? null, priority: input.priority ?? 'normal',
      notes: input.notes ?? '', status: 'open',
      createdAt: this.clock.iso(), updatedAt: this.clock.iso(),
    };
    this.table.put(id, rec);
    return rec;
  }

  update(id, patch) {
    const rec = this.table.get(id);
    const next = {
      ...rec,
      status: patch.status ?? rec.status,
      notes: patch.notes ?? rec.notes,
      updatedAt: this.clock.iso(),
      version: (rec.version ?? 0) + 1,
    };
    this.table.put(id, next);
    return next;
  }

  list({ status = 'open', project = null } = {}) {
    return this.table
      .list((r) => (status === 'all' || r.status === status) && (!project || r.project === project))
      .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  }
}
