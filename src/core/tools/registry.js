/**
 * Jewel OS - capability registry.
 *
 * A tool is the ONLY way Jewel affects anything. Registration is the capability
 * surface, and it is deliberately strict:
 *
 *   - every tool declares a risk tier, an approval gate (or null), whether it
 *     has an external side effect, the scope and account it needs, and a
 *     schema for its arguments;
 *   - the registry is frozen after boot, so nothing loaded later can inject a
 *     capability or downgrade an existing one's risk;
 *   - re-registering a name is rejected, so a plugin cannot shadow `email.send`
 *     with a permissive impostor.
 *
 * This is what "no other builder can modify its capability" means in practice:
 * the surface is enumerable, sealed, and every entry is policy-checked at call
 * time by the executor - never by the tool itself.
 */
import { validate } from '../schema.js';
import { RISK, ALWAYS_APPROVE } from '../constitution.js';
import { ValidationError, NotFoundError, PolicyError } from '../errors.js';

/**
 * @typedef {object} Tool
 * @property {string} name              stable dotted id, e.g. 'gmail.send'
 * @property {string} description       written for a model to read
 * @property {object} input             schema for arguments
 * @property {string} risk              RISK tier
 * @property {string|null} [gate]       ALWAYS_APPROVE key, if gated
 * @property {boolean} [sideEffect]     true if it touches the outside world
 * @property {string|null} [scope]      required session scope
 * @property {string|null} [forbidden]  constitutional refusal tag
 * @property {boolean} [diagnostic]     survives seal lockdown (health checks only)
 * @property {(args:object, ctx:object)=>Promise<unknown>} run
 * @property {(args:object, ctx:object)=>Promise<unknown>} [simulate] dry-run behaviour
 * @property {(args:object)=>string} [summarize] one-line description for approvals
 * @property {(args:object)=>string|null} [accountOf] account this call binds to
 */

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, Tool>} */
    this.tools = new Map();
    this.frozen = false;
  }

  /** @param {Tool} tool */
  register(tool) {
    if (this.frozen) {
      throw new PolicyError('The capability registry is sealed. Tools cannot be added after boot.', { tool: tool?.name });
    }
    if (!tool?.name || !/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/.test(tool.name)) {
      throw new ValidationError('Tool name must be dotted lowercase, e.g. "gmail.send"', { name: tool?.name });
    }
    if (this.tools.has(tool.name)) {
      throw new PolicyError(`Tool "${tool.name}" is already registered. Capabilities cannot be shadowed.`, { name: tool.name });
    }
    if (typeof tool.run !== 'function') throw new ValidationError(`Tool "${tool.name}" needs a run()`, { name: tool.name });
    if (!tool.description) throw new ValidationError(`Tool "${tool.name}" needs a description`, { name: tool.name });
    if (!Object.values(RISK).includes(tool.risk)) {
      throw new ValidationError(`Tool "${tool.name}" declares an unknown risk tier`, { name: tool.name, risk: tool.risk });
    }
    if (tool.gate && !ALWAYS_APPROVE.includes(tool.gate)) {
      throw new ValidationError(`Tool "${tool.name}" declares an unknown approval gate "${tool.gate}"`, { name: tool.name });
    }
    if (tool.diagnostic && tool.sideEffect) {
      throw new ValidationError(`Tool "${tool.name}" cannot be both diagnostic and side-effecting.`, { name: tool.name });
    }

    // A side-effecting tool that claims low risk is almost always a mistake or
    // an attack. Refuse it at registration rather than discovering it later.
    if (tool.sideEffect && (tool.risk === RISK.NONE || tool.risk === RISK.LOW) && !tool.gate) {
      throw new ValidationError(
        `Tool "${tool.name}" has an external side effect but declares ${tool.risk} risk and no gate.`,
        { name: tool.name });
    }

    this.tools.set(tool.name, Object.freeze({
      gate: null, sideEffect: false, scope: null, forbidden: null, diagnostic: false, ...tool,
    }));
    return this;
  }

  /** @param {Tool[]} tools */
  registerAll(tools) {
    for (const t of tools) this.register(t);
    return this;
  }

  /** Seal the registry. Irreversible for the life of the process. */
  freeze() {
    this.frozen = true;
    Object.freeze(this.tools);
    return this;
  }

  has(name) { return this.tools.has(name); }

  /** @returns {Tool} */
  get(name) {
    const tool = this.tools.get(name);
    if (!tool) throw new NotFoundError(`No such capability: ${name}`, { name, available: this.names().length });
    return tool;
  }

  names() { return [...this.tools.keys()].sort(); }

  /** Validate and coerce arguments against the tool's schema. */
  validateArgs(name, args) {
    const tool = this.get(name);
    return tool.input ? validate(tool.input, args ?? {}, name) : (args ?? {});
  }

  /** The capability descriptor a tool call binds to in policy and approvals. */
  capabilityOf(name, args = {}) {
    const tool = this.get(name);
    return {
      name: tool.name,
      risk: tool.risk,
      gate: tool.gate,
      sideEffect: tool.sideEffect,
      scope: tool.scope,
      forbidden: tool.forbidden,
      diagnostic: tool.diagnostic === true,
      account: tool.accountOf ? tool.accountOf(args) : null,
    };
  }

  /** Machine-readable catalogue for a model, with risk stated plainly. */
  catalogue({ includeHighRisk = true } = {}) {
    return this.names()
      .map((n) => this.get(n))
      .filter((t) => includeHighRisk || (t.risk !== RISK.HIGH && t.risk !== RISK.CRITICAL))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input: t.input ?? { type: 'object', properties: {} },
        risk: t.risk,
        requiresApproval: !!t.gate || t.risk === RISK.HIGH || t.risk === RISK.CRITICAL,
        sideEffect: t.sideEffect,
      }));
  }

  /** Stable fingerprint of the capability surface - printed by `doctor`. */
  fingerprintParts() {
    return this.names().map((n) => {
      const t = this.get(n);
      return `${t.name}:${t.risk}:${t.gate ?? '-'}:${t.sideEffect ? 'fx' : 'ro'}`;
    });
  }
}
