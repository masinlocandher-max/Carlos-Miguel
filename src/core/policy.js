/**
 * Jewel OS - policy engine.
 *
 * Every capability invocation passes through `decide()`. There is exactly one
 * decision point, so there is exactly one place to audit, test and reason about.
 * A tool cannot opt out: the executor calls the engine, not the tool.
 *
 * Decision order is deliberate - cheapest and most absolute checks first, so a
 * forbidden or unauthenticated call never reaches a provider:
 *
 *   1. seal       a broken capability seal disables everything but diagnostics
 *   2. forbidden  constitutional refusals - not approvable by anyone
 *   3. identity   authenticated? authorized for this account/scope?
 *   4. mode       dry-run blocks real side effects
 *   5. degraded   unsigned seal caps the maximum permitted risk
 *   6. gate       risk tier + ALWAYS_APPROVE -> approval required?
 *
 * The engine returns a decision object rather than throwing, so the denial
 * itself is auditable and explainable to FMB in her own words.
 */
import { CONSTITUTION, RISK, RISK_ORDER, ALWAYS_APPROVE, FORBIDDEN } from './constitution.js';
import { EVENT } from './audit.js';

export const EFFECT = Object.freeze({
  ALLOW: 'allow',
  APPROVE: 'approve',   // allowed once FMB grants a payload-bound approval
  DENY: 'deny',         // refused under current conditions
  REFUSE: 'refuse',     // constitutionally forbidden, never approvable
});

export const MODE = Object.freeze({ LIVE: 'live', DRYRUN: 'dryrun' });

/** @param {string} risk @param {string} threshold */
export function riskAtLeast(risk, threshold) {
  return RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(threshold);
}

/**
 * @typedef {object} PolicyContext
 * @property {{ authenticated:boolean, id?:string, isOwner?:boolean, scopes?:string[], accounts?:string[] }} principal
 * @property {{ ok:boolean, signed:boolean }} seal
 * @property {string} mode                 MODE.LIVE | MODE.DRYRUN
 * @property {string} [maxRiskWhenUnsigned]
 *
 * @typedef {object} Decision
 * @property {string} effect
 * @property {string} reason               stable machine code
 * @property {string} message              FMB-readable explanation
 * @property {boolean} requiresApproval
 * @property {string} risk
 * @property {string[]} obligations        what the executor must additionally do
 */

/**
 * @param {{ name:string, risk:string, gate?:string|null, sideEffect?:boolean,
 *           account?:string|null, scope?:string|null, forbidden?:string|null,
 *           diagnostic?:boolean }} capability
 * @param {PolicyContext} ctx
 * @returns {Decision}
 */
export function decide(capability, ctx) {
  const risk = capability.risk ?? RISK.MEDIUM;
  const obligations = [];

  const deny = (effect, reason, message, extra = {}) => ({
    effect, reason, message, risk, requiresApproval: false, obligations, ...extra,
  });

  // 1. Seal ------------------------------------------------------------------
  // Lockdown is deliberately narrow: ONLY capabilities that opt in as
  // diagnostics survive a broken seal. "Low risk" is not a pass - reading
  // private memory is harmless to the world and catastrophic to FMB.
  if (!ctx.seal?.ok && capability.diagnostic !== true) {
    return deny(EFFECT.DENY, 'seal-broken',
      'The capability seal does not verify, so Jewel is in lockdown. Only diagnostics run until the core is re-sealed.');
  }

  // 2. Constitutional refusals ----------------------------------------------
  const forbiddenTag = capability.forbidden ?? null;
  if (forbiddenTag && FORBIDDEN.includes(forbiddenTag)) {
    return deny(EFFECT.REFUSE, 'forbidden',
      `This is something Jewel will not do under any approval: ${forbiddenTag}.`);
  }

  // 3. Identity --------------------------------------------------------------
  if (!ctx.principal?.authenticated) {
    return deny(EFFECT.DENY, 'unauthenticated',
      'Jewel could not confirm who is asking. Retrieval and action are both closed until the session is authenticated.');
  }

  if (capability.scope && Array.isArray(ctx.principal.scopes) && !ctx.principal.scopes.includes(capability.scope)) {
    return deny(EFFECT.DENY, 'scope-missing',
      `This session is not authorized for "${capability.scope}".`, { missingScope: capability.scope });
  }

  if (capability.account && Array.isArray(ctx.principal.accounts) && ctx.principal.accounts.length > 0
      && !ctx.principal.accounts.includes(capability.account)) {
    return deny(EFFECT.DENY, 'account-not-authorized',
      `The account ${capability.account} is not on this session's authorized list. Authority is never inferred from a name mentioned in conversation.`,
      { account: capability.account });
  }

  // 4. Execution mode --------------------------------------------------------
  if (capability.sideEffect && ctx.mode === MODE.DRYRUN) {
    obligations.push('simulate-only');
  }

  // 5. Degraded seal ---------------------------------------------------------
  // High risk requires a PINNED seal - one whose signing key matches a trust
  // anchor held outside the seal document. A merely `signed` seal proves only
  // that whoever produced it owned a key, which an attacker who re-signed the
  // core also does. Accepting `signed` here would make the signature
  // decorative.
  if (ctx.seal?.ok && ctx.seal.pinned !== true) {
    const cap = ctx.maxRiskWhenUnsigned ?? RISK.MEDIUM;
    if (riskAtLeast(risk, RISK.HIGH) && riskAtLeast(risk, cap)) {
      const reason = ctx.seal.trust === 'unpinned' && ctx.seal.signed
        ? 'The core is signed, but by a key Jewel has no way to confirm is FMB\'s. High-risk actions stay disabled until the signing key matches a trusted one.'
        : 'The core verifies but is not owner-signed, so high-risk actions are disabled. Re-seal with FMB\'s key to restore them.';
      return deny(EFFECT.DENY, 'unpinned-seal', reason);
    }
  }

  // 6. Approval gate ---------------------------------------------------------
  const gate = capability.gate ?? null;
  const gated = (gate && ALWAYS_APPROVE.includes(gate)) || riskAtLeast(risk, RISK.HIGH);

  if (gated) {
    if (riskAtLeast(risk, RISK.CRITICAL)) obligations.push('confirm-twice');
    obligations.push('bind-payload', 'idempotency-claim', 'audit-receipt');
    return {
      effect: EFFECT.APPROVE,
      reason: gate ? 'gated-action' : 'high-risk',
      message: gate
        ? `"${gate}" always needs FMB's approval before Jewel acts.`
        : 'This action carries high risk, so it needs FMB\'s approval.',
      requiresApproval: true,
      risk,
      obligations,
    };
  }

  if (capability.sideEffect) obligations.push('idempotency-claim', 'audit-receipt');

  return {
    effect: EFFECT.ALLOW,
    reason: 'permitted',
    message: 'Permitted under current policy.',
    requiresApproval: false,
    risk,
    obligations,
  };
}

/**
 * Policy engine bound to an audit log, so every decision leaves a record.
 */
export class PolicyEngine {
  /** @param {{ audit:object, mode?:string, maxRiskWhenUnsigned?:string }} opts */
  constructor({ audit, mode = MODE.DRYRUN, maxRiskWhenUnsigned = RISK.MEDIUM }) {
    this.audit = audit;
    this.mode = mode;
    this.maxRiskWhenUnsigned = maxRiskWhenUnsigned;
    this.constitution = CONSTITUTION;
  }

  /**
   * @param {object} capability
   * @param {{ principal:object, seal:object, correlationId?:string }} ctx
   * @returns {Decision}
   */
  evaluate(capability, ctx) {
    const decision = decide(capability, {
      principal: ctx.principal,
      seal: ctx.seal,
      mode: this.mode,
      maxRiskWhenUnsigned: this.maxRiskWhenUnsigned,
    });
    this.audit.write(EVENT.POLICY_DECISION, {
      capability: capability.name,
      risk: decision.risk,
      gate: capability.gate ?? null,
      effect: decision.effect,
      reason: decision.reason,
      obligations: decision.obligations,
      mode: this.mode,
      sealSigned: !!ctx.seal?.signed,
      sealPinned: !!ctx.seal?.pinned,
      sealTrust: ctx.seal?.trust ?? 'unknown',
    }, {
      actor: ctx.principal?.id ?? 'unknown',
      subject: capability.name,
      correlationId: ctx.correlationId ?? null,
      outcome: decision.effect,
    });
    return decision;
  }
}
