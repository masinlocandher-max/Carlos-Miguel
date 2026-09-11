/**
 * Jewel OS - the kernel.
 *
 * Boot order is a security property, not a convenience:
 *
 *   1. verify the capability seal FIRST, before any subsystem exists;
 *   2. open the audit chain and record the boot (including a failed seal, so a
 *      tampered start is itself evidence);
 *   3. build subsystems;
 *   4. register tools, then FREEZE the registry - after this point no code path
 *      can add, replace or downgrade a capability for the life of the process.
 *
 * If the seal is broken, the kernel still boots but in LOCKDOWN: the policy
 * engine permits only capabilities explicitly marked `diagnostic`. Jewel stays
 * able to explain what is wrong; she loses the ability to act.
 */
import { join } from 'node:path';
import { verifySeal } from './integrity.js';
import { AuditLog, EVENT } from './audit.js';
import { PolicyEngine } from './policy.js';
import { ApprovalQueue } from './approvals.js';
import { IdempotencyLedger } from './idempotency.js';
import { MemoryVault } from './memory.js';
import { ToolRegistry } from './tools/registry.js';
import { Executor } from './agent/executor.js';
import { Planner } from './agent/planner.js';
import { AgentLoop } from './agent/loop.js';
import { JsonTable, dataDir } from './store.js';
import { systemClock } from './clock.js';
import { CONSTITUTION } from './constitution.js';
import { canonicalHash } from './ids.js';

/**
 * @param {{ root:string, config:object, clock?:object, model?:object,
 *           workspace?:object, toolFactory?:Function, taskStoreFactory?:Function }} opts
 */
export async function boot(opts) {
  const { root, config } = opts;
  const clock = opts.clock ?? systemClock;

  // 1. Seal, before anything else exists.
  const seal = verifySeal(root, { key: config.sealKey, sealPath: config.sealPath ?? null });

  // 2. Audit chain.
  const dir = dataDir(root, config.dataDir);
  const audit = new AuditLog(join(dir, 'audit.jsonl'), { clock });

  audit.write(seal.ok ? EVENT.SEAL_VERIFIED : EVENT.SEAL_VIOLATION, {
    ok: seal.ok, signed: seal.signed, summary: seal.summary, violations: seal.violations,
  }, { outcome: seal.ok ? 'verified' : 'violation' });

  // 3. Subsystems.
  const approvals = new ApprovalQueue({ dir: join(dir, 'approvals'), audit, clock, ttlMs: config.approvalTtlMs });
  const ledger = new IdempotencyLedger({ dir: join(dir, 'idempotency'), audit, clock });
  const memory = new MemoryVault({ dir: join(dir, 'memory'), audit, clock });
  const policy = new PolicyEngine({ audit, mode: config.mode });
  const tasks = opts.taskStoreFactory
    ? opts.taskStoreFactory({ table: new JsonTable(join(dir, 'tasks')), clock, audit })
    : null;

  const workspace = opts.workspace ?? { notion: unconfigured('Notion'), google: unconfigured('Google'), github: unconfigured('GitHub') };
  const model = opts.model ?? null;

  // 4. Capabilities, then seal the registry.
  const registry = new ToolRegistry();
  if (opts.toolFactory) {
    registry.registerAll(opts.toolFactory({ memory, approvals, audit, workspace, tasks, seal, ledger, registry, config }));
  }
  registry.freeze();

  const executor = new Executor({ registry, policy, approvals, ledger, audit, seal, mode: config.mode, clock });
  const planner = new Planner({ memory, mode: config.mode, locale: config.locale });
  const agent = model
    ? new AgentLoop({ model, registry, executor, planner, audit, approvals, seal, maxSteps: config.maxSteps })
    : null;

  const capabilityFingerprint = canonicalHash(registry.fingerprintParts());

  audit.write(EVENT.BOOT, {
    mode: config.mode,
    constitution: CONSTITUTION.version,
    capabilities: registry.names().length,
    capabilityFingerprint,
    sealed: seal.ok,
    signed: seal.signed,
    lockdown: !seal.ok,
  }, { outcome: seal.ok ? 'ok' : 'lockdown' });

  return {
    root, config, clock, seal, audit, approvals, ledger, memory, policy,
    registry, executor, planner, agent, tasks, workspace, model,
    capabilityFingerprint,
    lockdown: !seal.ok,

    /** The principal for FMB's own session. */
    owner() {
      return {
        authenticated: true,
        id: config.owner,
        isOwner: true,
        scopes: config.scopes,
        accounts: config.accounts ?? [],
        clearance: config.clearance,
      };
    },
  };
}

function unconfigured(name) {
  return {
    name, configured: false,
    _assert() { throw new Error(`${name} is not connected.`); },
  };
}
