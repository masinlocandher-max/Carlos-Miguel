/**
 * Jewel OS - the agent loop.
 *
 * Drives a model through tool use, with every tool call passing through the
 * Executor (and therefore the policy engine, approval binding, idempotency
 * ledger and audit chain). The loop itself has NO authority: it can only ask
 * for capabilities, never grant them.
 *
 * Three properties worth naming, because they are what stop an agent loop from
 * becoming a liability:
 *
 *   BOUNDED    a hard step ceiling and a wall-clock deadline. An agent that can
 *              loop forever is an agent that will, usually at 2am.
 *
 *   HONEST     when a tool returns pending_approval, that is reported to the
 *              model AND surfaced to FMB. The loop never lets a turn end with
 *              the model claiming it did something the executor refused.
 *
 *   OBSERVABLE every turn is audited with a correlation id, so any answer can
 *              be traced back to the exact tool calls and sources behind it.
 */
import { newId } from '../ids.js';
import { EVENT } from '../audit.js';
import { toJewelError } from '../errors.js';
import { scan } from '../untrusted.js';
import { classify } from './planner.js';

export const DEFAULT_MAX_STEPS = 12;
export const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

/**
 * @typedef {object} TurnResult
 * @property {string} answer
 * @property {string} correlationId
 * @property {number} steps
 * @property {{name:string,status:string,message:string}[]} actions
 * @property {{id:string,ref:string,summary:string}[]} awaitingApproval
 * @property {string[]} warnings
 * @property {object} usage
 * @property {boolean} truncated
 */

export class AgentLoop {
  /**
   * @param {{ model:object, registry:object, executor:object, planner:object,
   *           audit:object, approvals:object, seal:object,
   *           maxSteps?:number, deadlineMs?:number }} deps
   */
  constructor(deps) {
    this.model = deps.model;
    this.registry = deps.registry;
    this.executor = deps.executor;
    this.planner = deps.planner;
    this.audit = deps.audit;
    this.approvals = deps.approvals;
    this.seal = deps.seal;
    this.maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /**
   * Run one full turn.
   * @param {string} request
   * @param {{ principal:object, correlationId?:string, history?:object[] }} ctx
   * @returns {Promise<TurnResult>}
   */
  async run(request, ctx) {
    const correlationId = ctx.correlationId ?? newId('cor');
    const deadline = Date.now() + this.deadlineMs;
    const warnings = [];
    const actions = [];
    const awaitingApproval = [];
    const usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };

    const intent = classify(request);

    // Screen the owner's own input too: FMB may be forwarding an attacker's
    // text without realising it. This is a warning, never a refusal.
    const ownerScan = scan(request);
    if (ownerScan.suspicious) {
      warnings.push('This request contains instruction-injection patterns. If you forwarded it from somewhere, treat the source as untrusted.');
      this.audit.write(EVENT.INJECTION_DETECTED, { where: 'owner-input', signals: ownerScan.signals },
        { correlationId, outcome: 'flagged' });
    }

    const memoryCtx = this.planner.context(request, ctx.principal);
    if (memoryCtx.injectionSignals.length) {
      warnings.push(`Retrieved content from ${[...new Set(memoryCtx.injectionSignals.map((s) => s.sourceId))].join(', ')} tried to issue instructions. Jewel treated it as data.`);
      this.audit.write(EVENT.INJECTION_DETECTED, { where: 'retrieved-content', signals: memoryCtx.injectionSignals },
        { correlationId, outcome: 'contained' });
    }

    const capabilities = this.registry.catalogue();
    const system = this.planner.system({
      capabilities,
      seal: this.seal,
      pendingApprovals: this.approvals.pending().length,
    });

    const messages = [...(ctx.history ?? []), this.planner.openingTurn(request, memoryCtx)];

    this.audit.write(EVENT.AGENT_TURN, { intent: intent.intent, request: String(request).slice(0, 500), steps: 0 },
      { actor: ctx.principal?.id ?? 'unknown', correlationId, outcome: 'started' });

    let answer = '';
    let steps = 0;
    let truncated = false;

    while (steps < this.maxSteps) {
      if (Date.now() > deadline) {
        truncated = true;
        warnings.push('Jewel stopped at the time limit for this turn. Nothing was left half-done that had a side effect.');
        break;
      }
      steps += 1;

      let response;
      try {
        response = await this.model.complete({
          system,
          messages,
          tools: capabilities,
          correlationId,
        });
        usage.modelCalls += 1;
        usage.inputTokens += response.usage?.input_tokens ?? 0;
        usage.outputTokens += response.usage?.output_tokens ?? 0;
      } catch (err) {
        const e = toJewelError(err);
        this.audit.write(EVENT.AGENT_TURN, { step: steps, error: e.toJSON() },
          { correlationId, outcome: 'model-failure' });
        return this._finish({
          answer: answer || `Jewel could not reach the model: ${e.message}`,
          correlationId, steps, actions, awaitingApproval,
          warnings: [...warnings, 'The model call failed. Nothing was executed.'],
          usage, truncated: true,
        });
      }

      if (response.text) answer = response.text;

      if (!response.toolCalls?.length) break;

      // Execute every requested tool, then return ALL results in one turn.
      const results = [];
      for (const call of response.toolCalls) {
        const outcome = await this.executor.call(call.name, call.args, {
          principal: ctx.principal,
          correlationId,
        });

        actions.push({ name: call.name, status: outcome.status, message: outcome.message });

        if (outcome.status === 'pending_approval' && outcome.approval) {
          awaitingApproval.push(outcome.approval);
        }

        const isError = ['failed', 'denied', 'refused'].includes(outcome.status);
        results.push({
          id: call.id,
          isError,
          content: {
            status: outcome.status,
            message: outcome.message,
            result: outcome.result ?? null,
            error: outcome.error ?? null,
          },
        });
      }

      messages.push(
        { role: 'assistant', content: response.raw?.content ?? [{ type: 'text', text: response.text ?? '' }] },
        {
          role: 'user',
          content: results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: JSON.stringify(r.content),
            ...(r.isError ? { is_error: true } : {}),
          })),
        },
      );
    }

    if (steps >= this.maxSteps && !truncated) {
      truncated = true;
      warnings.push(`Jewel reached the ${this.maxSteps}-step limit for one turn.`);
    }

    return this._finish({ answer, correlationId, steps, actions, awaitingApproval, warnings, usage, truncated });
  }

  _finish(result) {
    // INV-9 applied at the boundary: if a gated action is waiting, the answer
    // must not read as if the action happened.
    if (result.awaitingApproval.length) {
      const refs = result.awaitingApproval.map((a) => `${a.ref} - ${a.summary}`).join('\n');
      result.answer = `${result.answer ? `${result.answer}\n\n` : ''}Nothing was sent. Waiting on your approval:\n${refs}\n\nApprove with: jewel approve <ref>`;
    }
    if (!result.answer) {
      result.answer = 'Jewel completed the turn without producing an answer. That is a bug worth reporting, not a silence to interpret.';
    }
    this.audit.write(EVENT.AGENT_TURN, {
      steps: result.steps, actions: result.actions.length,
      awaiting: result.awaitingApproval.length, truncated: result.truncated,
    }, { correlationId: result.correlationId, outcome: 'finished' });
    return result;
  }
}
