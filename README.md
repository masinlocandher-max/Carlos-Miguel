# Jewel OS

Jewel is FMB's executive assistant: a sealed agent runtime that can read, draft,
remember and act — where every action that touches the outside world is
approved by FMB against its exact payload, recorded in a tamper-evident ledger,
and impossible to duplicate by accident.

Carlos Miguel is the legacy repository name. Jewel is the active identity.

## Quick start

No install step and no dependencies for the runtime. Node 22 or newer.

```bash
node jewel.mjs init            # generates your keys, writes .env.local, seals the core
node jewel.mjs doctor          # health, seal, providers, what is waiting on you
```

`init` prints your seal key **once**. Copy it into your password manager before
you do anything else — without it you cannot re-seal the core. It also writes
`.env.local` (gitignored, mode 600) with everything else already filled in.
Add a model key and your authorized accounts to that file and run `doctor`
again; it lists exactly what is still missing.

Jewel starts in **dry run**. Nothing reaches the outside world until you set
`JEWEL_EXECUTION_MODE=live` yourself.

```bash
npm test                       # 147 tests, including every acceptance check
npm run verify                 # verify the capability seal

npm run serve                  # local control API for the command centre
npm run dev                    # the command centre itself (needs npm ci first)
```

## Commands

```
jewel init                   first-run setup: keys, config, seal
jewel doctor                 health, seal, providers, pending work
jewel ask "<request>"        one full agent turn
jewel approvals              what is waiting on you
jewel show <ref>             the exact payload an approval unlocks
jewel approve <ref>          grant it (single-use)
jewel deny <ref> [reason]    refuse it
jewel audit [traceId]        verify the chain, or print one receipt
jewel memory <query>         search memory with provenance
jewel tools                  the sealed capability surface
jewel call <tool> '<json>'   invoke one capability directly
jewel serve                  start the local control API
```

## What makes this safe to give real access

**Approvals bind to the payload, not the action type.** Approving "send email"
would be useless — the danger is in the content. Jewel approves
`sha256(action + account + payload)`. Change one character of a body, one
recipient, or the sending account, and the approval no longer matches. Grants
are single-use, expiring, revocable, and Jewel cannot approve her own request.

**Retrieved content can never become instruction.** An email, a Notion page or a
file is wrapped as data with a delimiter it cannot forge. Injection patterns are
flagged so you can see the attempt — but the flagging is telemetry, never the
gate. An attacker who fully controls the model still cannot act, because
approval happens out of band against a payload you can read in full.

**Retries cannot send twice.** Every side effect claims an idempotency key and
settles it. An attempt that starts and never reports back resolves to
*indeterminate* and asks you, because silently re-sending is worse than asking.

**Failure never looks like success.** An unconfigured provider throws rather
than returning empty results, so "not connected" can never be mistaken for
"nothing found". A partial result reports as partial.

**Everything is on the record.** Each action writes a hash-chained audit record
before it becomes observable. Altering or deleting any entry breaks every hash
after it, and `jewel audit` names the exact record where the chain diverges.
Secrets are redacted before writing, by pattern and by registered value.

**The capability surface is sealed.** See below.

## The seal — and its honest limit

Every file that defines what Jewel can do is hashed, and the manifest is signed
with a key only FMB holds. The runtime verifies on every boot and refuses to act
if anything changed. CI verifies on every push.

This does **not** make the files unwritable — nothing can. What it does is make
a modified Jewel unusable and undeniable: without your key, an altered core
fails verification, refuses to act, and fails CI. Someone can fork and gut her,
but then it is their program wearing her name, and that is a visible choice
rather than a silent one.

The repository ships **unsigned on purpose**. A signature committed publicly
would be worthless. Create the real one once:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
export JEWEL_SEAL_KEY=<that value>
npm run seal && npm run verify
```

Until then Jewel reads, drafts, remembers and organizes — but will not take a
high-risk action. Full ceremony in [docs/SEAL.md](docs/SEAL.md).

## Configuration

Everything comes from the environment; see `.env.example`. Never commit real
values — `.env` and `.jewel/` are ignored, and a test fails the build if either
is ever tracked.

| Variable | Purpose |
|---|---|
| `JEWEL_SEAL_KEY` | Owner key. Required to seal and to enable high-risk actions |
| `JEWEL_EXECUTION_MODE` | `dryrun` (default) or `live`. Live must be chosen, never inherited |
| `JEWEL_ACCOUNTS` | Accounts Jewel may act as. **Authority is never inferred from a name in conversation** |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Model provider. Without one, Jewel says so rather than inventing answers |
| `NOTION_API_KEY`, `GOOGLE_ACCESS_TOKEN`, `GITHUB_TOKEN` | Workspace providers |

Routing follows AGENTS.md: **Notion** is the source of truth for memory, tasks,
approvals and project status. **Drive** is the vault for files. **GitHub** is
for code only, never the final store for private documents.

## Memory and provenance

Every record carries source id, source revision, retrieval time, project,
sensitivity, access restrictions, verification status and supersession links.

- New records are **unverified** and reported as not citable. Jewel will not
  state one as fact.
- Facts change: a newer record **supersedes** the old one rather than
  overwriting it, so the history stays auditable.
- When a source's permission is withdrawn, every derived record is **purged** —
  content destroyed, tombstone retained for audit continuity.
- Sensitivity is enforced on read, not merely labelled.
- The vault refuses to store anything that looks like a credential.

## Acceptance checks

The eleven checks the earlier README required "before claiming readiness" are
implemented as executable tests in `test/acceptance.test.js`, each named with
its original wording. They use synthetic fixtures only — no live credential,
no network. Run `npm test`.

## Current state, stated plainly

**Working:** the full enforcement path — policy, approvals, idempotency, audit,
memory, seal, agent loop, CLI, control API, and 21 capabilities. 147 tests pass.
`jewel init` takes a fresh clone to an owner-signed core in one command.

**Requires your action before real use:** sealing with your own key, adding
provider credentials, listing authorized accounts, and switching to live mode.
Until then Jewel runs in dry run, where nothing reaches the outside world.

**The command centre works.** Codex's visual shell is merged and connected.
`jewel serve` exposes a loopback-only, token-guarded control API; the shell
reads live approvals, tasks, memory and seal state through it, and you can
approve or deny from the panel. Typing a real request sends it to Jewel;
typing `focus mode` or `open projects` stays local and instant.

The API adds no authority — every call lands on the same policy, approval,
idempotency and audit path as the CLI, so the interface cannot grant itself a
capability.

Still placeholder: Projects, Files & Assets and GitHub have no live feed wired
yet. They say so rather than showing an empty panel that implies data. Voice
input is not implemented.

```bash
npm ci && npm run build       # once
node jewel.mjs serve          # terminal 1 — the runtime
npm run dev                   # terminal 2 — the command centre
```

**Not verified by this build:** that any particular credential works, or that
any provider account is connected. `jewel doctor` reports what is actually
configured. Connected apps elsewhere are not evidence that this system has
access.

## Documentation

- [docs/QUICKSTART.md](docs/QUICKSTART.md) — setup, the approval loop, and what to do when something is wrong
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, the ten invariants, why each choice was made
- [docs/SEAL.md](docs/SEAL.md) — the seal ceremony and its honest limits
- [docs/BUILD_STATE.md](docs/BUILD_STATE.md) — build progress and what remains
- [AGENTS.md](AGENTS.md) — the persona, rules and approval gates this runtime enforces
