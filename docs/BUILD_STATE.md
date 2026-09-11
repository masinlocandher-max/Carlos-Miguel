# Jewel OS — Build State

Durable progress record. Updated on every commit so work is never lost between
sessions. If a build is interrupted, start here.

## Status legend
DONE = written, tested, committed · WIP = in progress · TODO = not started

## Stages

| # | Stage | Status | Notes |
|---|-------|--------|-------|
| 1 | Core primitives (errors, clock, ids, redact) | DONE | 6 tests |
| 2 | Constitution + capability seal | DONE | AGENTS.md encoded as enforced rules |
| 3 | Storage + schema validation | DONE | zero-dep, atomic writes |
| 4 | Audit chain | DONE | 5 tests, tamper-evident |
| 5 | Untrusted content containment | DONE | 9 tests, INV-3 |
| 6 | Approval queue (payload-bound) | DONE | 13 tests, INV-1/INV-2 |
| 7 | Idempotency ledger | DONE | 6 tests, INV-5 |
| 8 | Policy engine | DONE | 13 tests |
| 9 | Memory / knowledge with provenance | DONE | 12 tests, revocation purges content |
| 10 | Tool registry | DONE | 10 tests, sealed after boot |
| 11 | Built-in tools | DONE | 20 capabilities |
| 12 | Provider adapters | DONE | unconfigured throws, never returns empty |
| 13a | Executor (enforced call path) | DONE | 15 tests |
| 13b | Agent loop + planner | DONE | bounded by steps and wall clock |
| 14 | Kernel (boot + wiring) | DONE | seal-first boot, registry frozen |
| 15 | CLI | DONE | doctor/ask/approvals/audit/memory/tools/call |
| 15b | Local control API | DONE | 11 tests, loopback + token, no new authority |
| 19 | Codex command centre merged | DONE | visual shell from codex/jewel-command-center |
| 20 | UI runtime bridge (src/lib/jewel.ts) | DONE | 7 tests, typed client |
| 21 | First-run setup (`jewel init`) + env loading | DONE | 13 tests, one command to usable |
| 22 | Command centre wired to live data | DONE | approvals, tasks, memory, seal/runtime strip |
| 16 | Seal ceremony + CI enforcement | DONE | seal-cli, CI workflow, CODEOWNERS |
| 17 | Acceptance-check suite (README) | DONE | all 11 checks executable, 123 tests total |
| 18 | Documentation | DONE | README, ARCHITECTURE, SEAL |

## Invariants under test
INV-1 approval binding · INV-2 edit invalidates · INV-3 data-not-instruction ·
INV-4 audit before observable · INV-5 no duplicate effects · INV-6 failure is
not success · INV-7 deny before provider call · INV-8 no secrets in logs ·
INV-9 no fabrication · INV-10 refuse to boot unsealed

## Codex handover

Codex built the visual command centre and stopped at the runtime boundary. Its
handoff said so directly: "No provider integration or live private data is
implemented", and `src/lib/model.ts` calls `parseCommand` "a narrow local
command router, not a model or a provider action executor".

That unfinished job is now done:
- `src/runtime/server.js` - the authenticated local control API
- `src/lib/jewel.ts` - the typed client the shell uses to reach it

That is now done too. `src/App.tsx` routes real requests to Jewel through the
control API, and the panels render live approvals (with approve/deny), tasks,
memory with citability, and a runtime strip showing seal and audit state.
Local chrome commands (`focus mode`, `open projects`) stay instant and offline.

Still open on the interface side: Projects, Files & Assets and GitHub sections
have no live feed wired yet (they report that honestly rather than showing a
placeholder that implies data). Voice input is still not implemented.

## Honest limitations
- The seal makes core modification detectable and unusable, not impossible.
  A fork can delete the check; it then fails CI and is no longer Jewel.
- Provider adapters ship in dry-run by default. No live credential is used or
  required until FMB explicitly configures one and switches mode.
