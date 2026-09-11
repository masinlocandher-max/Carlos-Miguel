#!/usr/bin/env node
/**
 * Jewel OS - command line.
 *
 * Usage:
 *   jewel doctor                 health, seal, providers, pending work
 *   jewel ask "<request>"        one full agent turn
 *   jewel approvals              what is waiting on FMB
 *   jewel approve <ref> [note]   grant one approval
 *   jewel deny <ref> [reason]    refuse one approval
 *   jewel show <ref>             the exact payload an approval unlocks
 *   jewel audit [correlationId]  verify the chain, or print one receipt
 *   jewel memory <query>         search memory with provenance
 *   jewel tools                  the sealed capability surface
 *   jewel call <tool> '<json>'   invoke one capability directly
 *
 * Every command runs through the same kernel, so the CLI has no privilege the
 * agent does not have.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './src/core/kernel.js';
import { loadConfig, configReport, loadEnvFiles } from './src/runtime/config.js';
import { builtinTools, TaskStore } from './src/tools/index.js';
import { createModel } from './src/adapters/model.js';
import { createWorkspace } from './src/adapters/workspace.js';
import { toJewelError } from './src/core/errors.js';
import { redact } from './src/core/redact.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const out = (...a) => process.stdout.write(`${a.join(' ')}\n`);
const err = (...a) => process.stderr.write(`${a.join(' ')}\n`);

async function main(argv) {
  const [command = 'doctor', ...rest] = argv;

  // `init` runs before any kernel exists - there may be nothing to boot yet.
  if (command === 'init') return init(rest);

  // Read .env.local / .env. Anything already exported wins over the file.
  loadEnvFiles(ROOT);
  const config = loadConfig();

  const kernel = await boot({
    root: ROOT,
    config,
    model: createModel({
      anthropicKey: config.anthropicKey, openaiKey: config.openaiKey,
      prefer: config.preferProvider, model: config.anthropicModel ?? config.openaiModel,
    }),
    workspace: createWorkspace(config),
    toolFactory: builtinTools,
    taskStoreFactory: (d) => new TaskStore(d),
  });

  const principal = kernel.owner();

  switch (command) {
    case 'doctor': return doctor(kernel, config);
    case 'ask': return ask(kernel, principal, rest.join(' '));
    case 'approvals': return listApprovals(kernel);
    case 'approve': return decide(kernel, 'grant', rest);
    case 'deny': return decide(kernel, 'deny', rest);
    case 'show': return show(kernel, rest[0]);
    case 'audit': return auditCmd(kernel, rest[0]);
    case 'memory': return memoryCmd(kernel, principal, rest.join(' '));
    case 'tools': return toolsCmd(kernel);
    case 'call': return callCmd(kernel, principal, rest);
    case 'serve': return serve(kernel);
    case 'setup': return init(rest);
    case 'help': case '--help': case '-h': return help();
    default:
      err(`Unknown command: ${command}`);
      help();
      process.exitCode = 2;
  }
}

function help() {
  out(`Jewel OS

  jewel init                   first-run setup: keys, config, seal
  jewel doctor                 health, seal, providers, pending work
  jewel ask "<request>"        one full agent turn
  jewel approvals              what is waiting on you
  jewel approve <ref> [note]   grant one approval
  jewel deny <ref> [reason]    refuse one approval
  jewel show <ref>             the exact payload an approval unlocks
  jewel audit [correlationId]  verify the chain, or print one receipt
  jewel memory <query>         search memory with provenance
  jewel tools                  the sealed capability surface
  jewel call <tool> '<json>'   invoke one capability directly
  jewel serve                  start the local control API
`);
}

async function init(rest) {
  const { initialize } = await import('./src/runtime/setup.js');
  const force = rest.includes('--force');

  let result;
  try {
    result = initialize(ROOT, { force });
  } catch (e) {
    err(`Setup stopped: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (!result.created) {
    for (const w of result.warnings) out(w);
    out('');
    out('Nothing was changed. Run `jewel doctor` to see what is still missing.');
    process.exitCode = 1;
    return;
  }

  for (const w of result.warnings) out(`  ! ${w}`);

  out('');
  out('Jewel is set up.');
  out('');
  out(`  wrote       .env.local  (gitignored, mode 600)`);
  if (result.sealed) {
    out(`  sealed      ${result.sealed.files} core files, seal #${result.sealed.sealNumber}${result.sealed.signed ? ', owner-signed' : ''}`);
  }
  out('');
  out('  ┌─ SAVE THIS NOW ────────────────────────────────────────────────┐');
  out('  │ Your seal key. Copy it into your password manager.             │');
  out('  │ Lose it and you cannot re-seal the core.                       │');
  out('  └────────────────────────────────────────────────────────────────┘');
  out('');
  out(`  JEWEL_SEAL_KEY=${result.sealKey}`);
  out('');
  out('  It is also in .env.local. Never commit that file, never paste it into');
  out('  chat, never put it in Notion.');
  out('');
  out('Next:');
  out('  1. Add a model key to .env.local (ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  out('  2. Set JEWEL_ACCOUNTS to the accounts Jewel may act as');
  out('  3. node jewel.mjs doctor');
  out('');
  out('Jewel starts in dry run. Nothing reaches the outside world until you');
  out('set JEWEL_EXECUTION_MODE=live yourself.');
}

function doctor(kernel, config) {
  const chain = kernel.audit.verifyChain();
  const cfg = configReport(config);

  out('JEWEL OS');
  out('');
  out(`  identity        Jewel, EA to ${cfg.owner}`);
  out(`  mode            ${cfg.mode}${cfg.mode === 'dryrun' ? '  (nothing reaches the outside world)' : '  (LIVE - actions have real effects)'}`);
  out(`  capabilities    ${kernel.registry.names().length}  fingerprint ${kernel.capabilityFingerprint.slice(0, 16)}`);
  out('');
  out(`  seal            ${kernel.seal.ok ? 'OK' : 'BROKEN'}${kernel.seal.signed ? ' - owner-signed' : ' - unsigned'}`);
  out(`                  ${kernel.seal.summary}`);
  for (const v of kernel.seal.violations ?? []) out(`                  ! ${v.path} (${v.reason})`);
  if (kernel.lockdown) out('                  LOCKDOWN: only diagnostics will run.');
  out('');
  out(`  audit chain     ${chain.ok ? 'intact' : `BROKEN at record ${chain.brokenAt} (${chain.reason})`}  ${chain.length} records`);
  out(`  model           ${cfg.model}`);
  out(`  providers       notion:${yn(cfg.providers.notion)}  google:${yn(cfg.providers.google)}  github:${yn(cfg.providers.github)}`);
  out(`  accounts        ${cfg.authorizedAccounts} authorized`);
  out('');

  const pending = kernel.approvals.pending();
  out(`  waiting on you  ${pending.length}`);
  for (const p of pending.slice(0, 10)) out(`                  ${p.ref}  ${p.summary}`);

  const stuck = kernel.ledger.indeterminate();
  if (stuck.length) {
    out('');
    out(`  NEEDS A DECISION  ${stuck.length} action(s) started but never reported a result.`);
    out('                    The external effect may or may not have happened. Jewel will not retry on her own.');
  }

  out('');
  const gaps = [];
  if (!kernel.seal.signed) gaps.push('Re-seal with your key to enable high-risk capabilities: JEWEL_SEAL_KEY=... npm run seal');
  if (cfg.model === 'offline') gaps.push('No model key configured. Jewel cannot generate answers.');
  if (!cfg.authorizedAccounts) gaps.push('No authorized accounts. Set JEWEL_ACCOUNTS before any email or calendar work.');
  if (cfg.mode === 'dryrun') gaps.push('Dry run. Set JEWEL_EXECUTION_MODE=live when you are ready for real actions.');
  if (gaps.length) { out('  To go further:'); for (const g of gaps) out(`    - ${g}`); }
  else out('  Fully configured.');
}

const yn = (v) => (v ? 'yes' : 'no');

async function ask(kernel, principal, request) {
  if (!request) { err('Ask what? jewel ask "your request"'); process.exitCode = 2; return; }
  if (!kernel.agent) { err('No model configured. Jewel cannot answer.'); process.exitCode = 1; return; }

  const turn = await kernel.agent.run(request, { principal });

  out('');
  out(turn.answer);
  if (turn.actions.length) {
    out('');
    out('What Jewel did:');
    for (const a of turn.actions) out(`  ${a.status.padEnd(17)} ${a.name}  ${a.message}`);
  }
  if (turn.warnings.length) {
    out('');
    for (const w of turn.warnings) out(`  ! ${w}`);
  }
  out('');
  out(`  trace ${turn.correlationId}  (jewel audit ${turn.correlationId})`);
}

function listApprovals(kernel) {
  const pending = kernel.approvals.pending();
  if (!pending.length) { out('Nothing waiting on you.'); return; }
  out(`${pending.length} waiting on you:`);
  out('');
  for (const p of pending) {
    out(`  ${p.ref}  [${p.risk}]  ${p.summary}`);
    out(`         action ${p.action}${p.account ? ` as ${p.account}` : ''}, expires ${p.expiresAt}`);
  }
  out('');
  out('  jewel show <ref>     see the exact payload');
  out('  jewel approve <ref>  grant it');
}

function decide(kernel, verb, rest) {
  const [ref, ...note] = rest;
  if (!ref) { err(`Which approval? jewel ${verb === 'grant' ? 'approve' : 'deny'} <ref>`); process.exitCode = 2; return; }
  const record = kernel.approvals.resolve(ref);
  const result = verb === 'grant'
    ? kernel.approvals.grant(record.id, { by: kernel.config.owner, note: note.join(' ') || null })
    : kernel.approvals.deny(record.id, { by: kernel.config.owner, reason: note.join(' ') || null });
  out(`${result.ref} ${result.state}: ${result.summary}`);
  if (result.state === 'granted') out('Ask Jewel again and she will carry it out. The grant is single-use.');
}

function show(kernel, ref) {
  if (!ref) { err('Which approval? jewel show <ref>'); process.exitCode = 2; return; }
  const r = kernel.approvals.resolve(ref);
  out(`${r.ref}  ${r.state}  [${r.risk}]`);
  out(`action    ${r.action}`);
  out(`account   ${r.account ?? '(none)'}`);
  out(`summary   ${r.summary}`);
  out(`requested ${r.requestedAt}  expires ${r.expiresAt}`);
  out(`binding   ${r.binding}`);
  out('');
  out('Exact payload this approval unlocks (any edit invalidates it):');
  out(JSON.stringify(redact(r.payload), null, 2));
}

function auditCmd(kernel, correlationId) {
  if (correlationId) {
    const receipt = kernel.audit.receipt(correlationId);
    if (!receipt) { err(`No records for ${correlationId}`); process.exitCode = 1; return; }
    out(`receipt ${receipt.correlationId}`);
    out(`  ${receipt.startedAt} -> ${receipt.endedAt}`);
    for (const s of receipt.steps) out(`  ${s.at}  ${s.event.padEnd(24)} ${s.outcome ?? ''}`);
    return;
  }
  const chain = kernel.audit.verifyChain();
  out(chain.ok
    ? `Audit chain intact. ${chain.length} records, none altered.`
    : `AUDIT CHAIN BROKEN at record ${chain.brokenAt}: ${chain.reason}. Records after this point cannot be trusted.`);
  if (!chain.ok) process.exitCode = 1;
}

function memoryCmd(kernel, principal, query) {
  const out_ = kernel.memory.search({ query, limit: 20 }, principal);
  if (!out_.results.length) { out('Nothing in memory matched. Jewel will not fill that gap with a guess.'); return; }
  for (const r of kernel.memory.toContext(out_.results)) {
    out(`  ${r.citable ? '[verified]  ' : '[unverified]'} ${r.subject}`);
    out(`               ${r.source}  retrieved ${r.retrievedAt}`);
  }
  if (out_.withheld) out(`\n  ${out_.withheld} record(s) withheld for clearance.`);
}

function toolsCmd(kernel) {
  out(`${kernel.registry.names().length} capabilities, sealed at boot:`);
  out('');
  for (const c of kernel.registry.catalogue()) {
    out(`  ${c.name.padEnd(28)} ${c.risk.padEnd(8)} ${c.requiresApproval ? 'needs approval' : c.sideEffect ? 'side effect' : 'read only'}`);
  }
  out('');
  out(`  fingerprint ${kernel.capabilityFingerprint}`);
}

async function callCmd(kernel, principal, rest) {
  const [name, json = '{}'] = rest;
  if (!name) { err("Which capability? jewel call <tool> '<json>'"); process.exitCode = 2; return; }
  let args;
  try { args = JSON.parse(json); }
  catch { err('Arguments must be valid JSON.'); process.exitCode = 2; return; }

  const result = await kernel.executor.call(name, args, { principal });
  out(`${result.status}: ${result.message}`);
  if (result.result !== undefined) out(JSON.stringify(redact(result.result), null, 2));
  if (result.approval) out(`\nApprove with: jewel approve ${result.approval.ref}`);
  if (['failed', 'denied', 'refused'].includes(result.status)) process.exitCode = 1;
}

async function serve(kernel) {
  const { createApi } = await import('./src/runtime/server.js');
  const api = createApi(kernel);
  const { host, port } = await api.listen();

  out(`Jewel control API on http://${host}:${port}`);
  out(`  mode        ${kernel.config.mode}`);
  out(`  seal        ${kernel.seal.ok ? (kernel.seal.signed ? 'signed' : 'unsigned') : 'BROKEN - lockdown'}`);
  out(`  loopback only. Every route but /health needs the bearer token.`);
  out('');
  out('  Start the command centre with:  npm run dev');
  out('  Stop with Ctrl-C.');

  const shutdown = async () => { await api.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main(process.argv.slice(2)).catch((e) => {
  const je = toJewelError(e);
  err(`${je.code}: ${je.message}`);
  process.exitCode = 1;
});
