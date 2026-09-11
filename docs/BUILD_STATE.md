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
| 11 | Built-in tools | TODO | |
| 12 | Provider adapters (OpenAI, Notion, Gmail, Calendar, Drive, GitHub) | TODO | |
| 13a | Executor (enforced call path) | DONE | 15 tests |
| 13b | Agent loop + planner | TODO | |
| 14 | Kernel (boot + wiring) | TODO | |
| 15 | CLI + HTTP API | TODO | |
| 16 | Seal ceremony + CI enforcement | TODO | |
| 17 | Acceptance-check suite (README) | TODO | |

## Invariants under test
INV-1 approval binding · INV-2 edit invalidates · INV-3 data-not-instruction ·
INV-4 audit before observable · INV-5 no duplicate effects · INV-6 failure is
not success · INV-7 deny before provider call · INV-8 no secrets in logs ·
INV-9 no fabrication · INV-10 refuse to boot unsealed

## Honest limitations
- The seal makes core modification detectable and unusable, not impossible.
  A fork can delete the check; it then fails CI and is no longer Jewel.
- Provider adapters ship in dry-run by default. No live credential is used or
  required until FMB explicitly configures one and switches mode.
