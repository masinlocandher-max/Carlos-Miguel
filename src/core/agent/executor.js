/**
 * Jewel OS - the executor.
 *
 * The single path from "a tool was chosen" to "something happened". Every
 * obligation the policy engine returns is discharged HERE, not inside tools,
 * so a tool cannot forget, skip or reorder a safety step.
 *
 * Order of operations for one call:
 *
 *   1. validate arguments against the tool schema (unknown fields rejected)
 *   2. policy decision -> allow | approve | deny | refuse
 *   3. if approval required: bind the payload hash and require a live grant
 *   4. claim the idempotency key (duplicate -> return the recorded outcome)
 *   5. audit EXECUTION_STARTED
 *   6. run (or simulate, in dry-run)
 *   7. settle the ledger and audit the terminal outcome
 *
 * INV-6 is structural: the only way to reach `succeeded` is for the tool to
 * return normally. A thrown error, a rejected promise, a timeout or a partial
 * provider response all settle as `failed` or `partial`. There is no code path
 * that reports success without the tool having returned.
 */
import { newId } from '../ids.js';
import { EFFECT } from '../policy.js';
import { bindingHash } from '../approvals.js';
import { idempotencyKey, OUTCOME } from '../idempotency.js';
import { EVENT } from '../audit.js';
import { toJewelError, PolicyError, ApprovalRequiredError } from '../errors.js';
import { redact } from '../redact.js';

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @typedef {object} ExecutionResult
 * @property {string} status    succeeded | failed | partial | deduped | pending_approval | denied | refused | simulated
 * @property {string} executionId
 * @property {string} correlationId
 * @property {unknown} [result]
 * @property {object} [error]
 * @property {object} [approval]
 * @property {string} message
 */

export class Executor {
  /**
   * @param {{ registry:object, policy:object, approvals:object, ledger:object,
   *           audit:object, seal:object, mode:string, clock?:object,
   *           timeoutMs?:number }} deps
   */
  constructor(deps) {
    this.registry = deps.registry;
    this.policy = deps.policy;
    this.approvals = deps.approvals;
    this.ledger = deps.ledger;
    this.audit = deps.audit;
    this.seal = deps.seal;
    this.mode = deps.mode;
    this.clock = deps.clock;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * @param {string} name
   * @param {object} rawArgs
   * @param {{ principal:object, correlationId?:string, scope?:string, autoRequestApproval?:boolean }} ctx
   * @returns {Promise<ExecutionResult>}
   */
  async call(name, rawArgs, ctx) {
    const correlationId = ctx.correlationId ?? newId('cor');
    const executionId = newId('exe');

    // 1. Arguments ----------------------------------------------------------
    let args;
    try {
      args = this.registry.validateArgs(name, rawArgs);
    } catch (err) {
      const e = toJewelError(err);
      this.audit.write(EVENT.TOOL_DENIED, { tool: name, reason: 'invalid-arguments', error: e.toJSON() },
        { correlationId, subject: name, outcome: 'invalid' });
      return { status: 'failed', executionId, correlationId, error: e.toJSON(), message: e.message };
    }

    const tool = this.registry.get(name);
    const capability = this.registry.capabilityOf(name, args);

    this.audit.write(EVENT.TOOL_CALL, { tool: name, args: redact(args), risk: capability.risk },
      { actor: ctx.principal?.id ?? 'unknown', correlationId, subject: name });

    // 2. Policy -------------------------------------------------------------
    const decision = this.policy.evaluate(capability, { principal: ctx.principal, seal: this.seal, correlationId });

    if (decision.effect === EFFECT.REFUSE) {
      return { status: 'refused', executionId, correlationId, message: decision.message,
        error: new PolicyError(decision.message, { reason: decision.reason }).toJSON() };
    }
    if (decision.effect === EFFECT.DENY) {
      return { status: 'denied', executionId, correlationId, message: decision.message,
        error: new PolicyError(decision.message, { reason: decision.reason }).toJSON() };
    }

    // 3. Approval binding ---------------------------------------------------
    // The capability descriptor is part of the binding: an approval granted
    // while email.send was gated must not survive a build that ungates it.
    const binding = bindingHash({
      action: capability.gate ?? name, payload: args,
      account: capability.account, capability,
    });
    const idemKey = idempotencyKey({ action: capability.gate ?? name, binding, scope: ctx.scope ?? null });
    const needsLedger = decision.obligations.includes('idempotency-claim');

    // If this exact action already reached a terminal outcome, say so before
    // asking FMB to approve it again. This is a READ of the ledger - it
    // reserves nothing, so it cannot be used to skip the approval gate for
    // anything that has not already run.
    if (needsLedger) {
      const prior = this.ledger.status(idemKey);
      if (prior.status === 'settled' && prior.outcome === OUTCOME.SUCCEEDED) {
        this.audit.write(EVENT.EXECUTION_DEDUPED, { tool: name, key: idemKey, previousOutcome: prior.outcome },
          { correlationId, subject: name, outcome: 'deduped' });
        return {
          status: 'deduped',
          executionId,
          correlationId,
          result: prior.result ?? null,
          message: `Already done on ${prior.at}. Jewel is not repeating it. Ask again explicitly if you want a fresh one.`,
        };
      }
    }

    let grant = null;

    if (decision.requiresApproval) {
      try {
        grant = this.approvals.requireGrant({
          action: capability.gate ?? name, payload: args,
          account: capability.account, capability,
        });
      } catch (err) {
        const e = toJewelError(err);
        if (!(e instanceof ApprovalRequiredError)) throw e;

        let request = null;
        if (ctx.autoRequestApproval !== false) {
          request = this.approvals.request({
            action: capability.gate ?? name,
            payload: args,
            account: capability.account,
            capability,
            risk: capability.risk,
            summary: tool.summarize ? tool.summarize(args) : `${name} with ${Object.keys(args).length} argument(s)`,
            effects: decision.obligations,
            correlationId,
          });
        }
        return {
          status: 'pending_approval',
          executionId,
          correlationId,
          approval: request ? { id: request.id, ref: request.ref, summary: request.summary, expiresAt: request.expiresAt } : null,
          message: request
            ? `Waiting on FMB. Approval ${request.ref}: ${request.summary}`
            : e.message,
          error: e.toJSON(),
        };
      }
    }

    // 4. Idempotency --------------------------------------------------------
    const key = idemKey;

    if (needsLedger) {
      const claim = this.ledger.claim(key, { executionId, action: name, correlationId });
      if (claim.status === 'duplicate') {
        return {
          status: 'deduped',
          executionId,
          correlationId,
          result: claim.result ?? null,
          message: claim.inFlight
            ? 'That exact action is already running. Jewel will not start a second one.'
            : `Already done. Jewel is not repeating it (previous outcome: ${claim.outcome}).`,
        };
      }
      if (claim.status === 'indeterminate') {
        return { status: 'partial', executionId, correlationId, message: claim.message,
          error: { code: 'INDETERMINATE_PRIOR_ATTEMPT', message: claim.message } };
      }
    }

    // 5. Execute ------------------------------------------------------------
    const simulate = decision.obligations.includes('simulate-only');
    this.audit.write(EVENT.EXECUTION_STARTED, { tool: name, executionId, simulate, approvalRef: grant?.ref ?? null },
      { correlationId, subject: name, outcome: 'started' });

    if (grant) this.approvals.consume(grant.id, executionId);

    try {
      const runner = simulate
        ? (tool.simulate ?? (async (a) => ({ simulated: true, wouldHaveRun: name, args: redact(a) })))
        : tool.run;

      const value = await this._withTimeout(runner(args, {
        principal: ctx.principal,
        correlationId,
        executionId,
        mode: this.mode,
        audit: this.audit,
      }), name);

      // INV-6: a tool may self-report a partial provider result.
      const partial = value && typeof value === 'object' && value.__partial === true;
      const outcome = partial ? OUTCOME.PARTIAL : OUTCOME.SUCCEEDED;

      if (needsLedger) this.ledger.settle(key, { executionId, outcome, result: redact(value), correlationId });

      this.audit.write(partial ? EVENT.EXECUTION_PARTIAL : EVENT.EXECUTION_SUCCEEDED,
        { tool: name, executionId, simulate, result: redact(value) },
        { correlationId, subject: name, outcome });

      this.audit.write(EVENT.TOOL_RESULT, { tool: name, ok: true, partial }, { correlationId, subject: name, outcome });

      return {
        status: simulate ? 'simulated' : (partial ? 'partial' : 'succeeded'),
        executionId,
        correlationId,
        result: value,
        message: simulate
          ? `Dry run only. Nothing left this machine. ${name} would have run.`
          : partial
            ? 'Completed partially. Review what did and did not go through.'
            : 'Done.',
      };
    } catch (err) {
      const e = toJewelError(err);
      if (needsLedger) this.ledger.settle(key, { executionId, outcome: OUTCOME.FAILED, error: e.toJSON(), correlationId });
      this.audit.write(EVENT.EXECUTION_FAILED, { tool: name, executionId, error: e.toJSON() },
        { correlationId, subject: name, outcome: OUTCOME.FAILED });
      return { status: 'failed', executionId, correlationId, error: e.toJSON(), message: `${name} failed: ${e.message}` };
    }
  }

  /** A hung provider must fail, never hang the assistant or look like success. */
  async _withTimeout(promise, name) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const e = toJewelError(new Error(`${name} timed out after ${this.timeoutMs}ms`));
            e.code = 'TIMEOUT';
            reject(e);
          }, this.timeoutMs);
          // Deliberately NOT unref'd: the timeout must be able to fire even
          // when nothing else keeps the loop alive, or a hung provider would
          // let the process exit with the call neither resolved nor failed.
          // The timer is always cleared in the finally block below.
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
