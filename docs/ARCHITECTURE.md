# Jewel OS — Architecture

## The idea in one paragraph

Jewel is an executive assistant that can act on the real world, built so that
every action she takes is *permitted, bound, recorded and reversible in
intent*. The design assumption is not that the model will behave — it is that
the model may be wrong, confused, or actively manipulated by something it read.
Every guarantee therefore lives outside the model, in code that runs whether the
model cooperates or not.

## Layers

```
  jewel.mjs                 CLI. No privilege the agent lacks.
      │
  core/kernel.js            Boot: verify seal → open audit → build → FREEZE registry
      │
  core/agent/loop.js        Model ↔ tools. Bounded by steps and wall clock.
      │                     Has no authority of its own.
  core/agent/executor.js    THE enforcement point. Every call passes here.
      │                     validate → decide → bind approval → claim → audit → run → settle
      ├── core/policy.js        one decision: allow | approve | deny | refuse
      ├── core/approvals.js     payload-bound, single-use, expiring grants
      ├── core/idempotency.js   claim/settle ledger — no duplicate effects
      ├── core/audit.js         hash-chained, tamper-evident, redacted
      ├── core/memory.js        provenance, supersession, revocation, clearance
      └── core/untrusted.js     external content contained as data
      │
  adapters/                 The only code that touches the network.
```

## The ten invariants

Every one is falsifiable and has a test. A rule that cannot fail is decoration.

| | Invariant | Enforced in |
|---|---|---|
| INV-1 | No external side effect without an approval bound to the exact payload hash | `approvals.js`, `executor.js` |
| INV-2 | Editing an approved payload invalidates the approval | `approvals.js` (`bindingHash`) |
| INV-3 | Retrieved content is data. It can never grant permission | `untrusted.js`, `policy.js` |
| INV-4 | Every state change writes an audit record before it is observable | `audit.js`, `executor.js` |
| INV-5 | Retries cannot duplicate an external effect | `idempotency.js`, `http.js` |
| INV-6 | A provider failure surfaces as failed or partial, never success | `executor.js`, `http.js` |
| INV-7 | Unauthenticated or unauthorized retrieval is denied before any provider call | `policy.js`, `memory.js` |
| INV-8 | Secrets never enter audit records, logs, responses or prompts | `redact.js` |
| INV-9 | Unknown facts are reported as unknown | `memory.js`, `planner.js` |
| INV-10 | The runtime refuses to act when the seal does not verify | `integrity.js`, `policy.js` |

## Why approvals bind to a hash

The naive design approves *an action type*: "Jewel may send email." That is
useless, because the dangerous part is the content, and content changes.

Jewel approves `sha256(canonical({action, account, payload}))`. You approve one
specific email — this body, these recipients, from this account. Change a single
character and the hash changes, no approval exists for the new payload, and
execution stops. The approval is also single-use, expiring, revocable, and
cannot be granted by Jewel herself.

This is what makes prompt injection survivable. An attacker who fully controls
the model still cannot act: approval is granted out of band by a human, against
a payload they can read in full with `jewel show <ref>`.

## Why prompt-injection *detection* is not the defence

`untrusted.js` flags known injection phrasings, and that flagging is useful —
you should know when a document tried something. But detection is a losing game,
so it is **telemetry, never a gate**. The trust decision never depends on
spotting the attack. Even a perfectly disguised injection runs into the approval
binding, the account allowlist, the frozen registry and the seal.

The structural defences are the real ones:

- external text is wrapped in a delimiter carrying a per-process random nonce
  the content cannot predict, and forged delimiters are neutralised;
- identity and rules come from the sealed constitution, not from a prompt file;
- the tool registry is frozen after boot, so nothing can add a capability;
- the loop can only *request* capabilities, never grant them.

## Why zero dependencies

Jewel's capability surface is sealed. A `node_modules` tree would place
thousands of files inside that boundary which the seal cannot meaningfully
cover, and any one of them could change what Jewel is able to do — the exact
risk the seal exists to close. So the dependency count is zero, and the
Anthropic and OpenAI wire formats are spoken directly.

The honest cost: the SDKs absorb API drift and this does not. If a provider
changes a shape, `src/adapters/model.js` must be updated by hand. That is a
maintenance burden accepted deliberately in exchange for a boundary that can
actually be verified.

## Failure behaviour

| Situation | What Jewel does |
|---|---|
| Seal broken | Lockdown. Only diagnostics. She can still explain what is wrong |
| Seal unsigned | Read, draft, organize. No high-risk action |
| No model key | Says so. Never fabricates an answer |
| Provider unconfigured | Throws. "Not connected" never looks like "nothing found" |
| Provider fails | `failed`, with the real error |
| Provider half-succeeds | `partial`, with what did and did not go through |
| Action started, never finished | `indeterminate`. Asks you. Never silently retries |
| Retrieval denied | Reports the denial. Never fills the gap with invention |
