# Jewel OS — Threat Model

Security claims are only meaningful with their assumptions attached. This
document states what Jewel defends against, what she does not, and what has to
be true for the defences to hold. Writing the assumptions down makes the
argument stronger, not weaker: a claim you can check is worth more than one
that sounds absolute.

## What is being protected

1. **FMB's authority.** Nothing consequential happens in her name that she did
   not specifically authorise.
2. **Private knowledge.** Notion content, mailbox content, client material and
   credentials do not leak into logs, prompts, git or third parties.
3. **The capability surface.** What Jewel *can* do changes only when FMB
   deliberately changes it.
4. **The record.** What happened is recoverable and tamper-evident.

## Trusted computing base

These are assumed honest. If one of them is compromised, the corresponding
guarantees do not hold, and no other part of the system can restore them.

| Component | Assumption | If it falls |
|---|---|---|
| **Host OS and user account** | Not compromised | Everything. An attacker with FMB's shell can read `.env.local`, sign seals and approve on her behalf |
| **The Ed25519 private key** | Held only by FMB | An attacker mints "owner-approved" builds |
| **The approval interface** | CLI or command centre is genuine, and the human reading it is FMB | Approval becomes theatre — she approves what an attacker drafted |
| **The executor and policy engine** | Running sealed, verified code | The gate can be removed |
| **Provider credentials** | Scoped to what Jewel needs | The provider can be driven directly, bypassing Jewel entirely |
| **Node.js and the OS crypto** | Correct | Signatures and hashes mean nothing |
| **The trust anchor, once** | `jewel.pub` verified out of band at least once | An attacker substitutes their key and everything verifies against itself |

Jewel's runtime has **zero third-party dependencies**, so the npm supply chain
is deliberately outside this list for the sealed core. The command-centre UI
does have dependencies; it sits outside the seal and can only reach the runtime
through the authenticated API, so a compromised UI package can misrepresent
what is on screen but cannot grant itself a capability.

## Adversaries, and what actually stops them

### 1. Prompt injection through retrieved content
**Capability:** fully controls the text of an email, Notion page, file or web
result that Jewel reads. Can say anything, in any phrasing.

**Stopped by:** the approval binding, not by detection. Even a perfectly
disguised injection that convinces the model to call `email.send` produces a
`pending_approval` — the grant must come out of band from FMB, against a
payload she can read in full. Structural containment (nonce-delimited untrusted
blocks) and injection flagging are defence in depth and telemetry; neither is
load-bearing.

**Holds only if:** FMB actually reads what she approves. An attacker who can
get a plausible-looking action approved has won, and no mechanism here prevents
that. `jewel show <ref>` exists so the real payload is one command away.

### 2. A compromised or adversarial model
**Capability:** the model itself is malicious or manipulated — it can emit any
tool call, any arguments, any text.

**Stopped by:** the model has no authority. The agent loop can only *request*
capabilities; the executor decides. The registry is frozen at boot, arguments
are schema-validated with unknown fields rejected, gated actions require a
payload-bound grant, and side effects are idempotency-claimed and audited.

**Holds only if:** the executor, policy engine and approval queue are running
sealed code, the signing key is uncompromised, and the approval interface is
genuine. A model that also controls the screen FMB approves on is not contained
by any of this.

This is the claim worth being precise about. An earlier version of the README
said "an attacker who fully owns the model still cannot act." That is true
*under these assumptions* and false without them. The accurate statement is:
**controlling the model is not sufficient to act; it must be combined with
control of the approval path, the executor, the signing key, the host, or the
provider credentials.**

### 3. A malicious or careless builder
**Capability:** can edit any file in the repository and open pull requests.

**Stopped by:** the capability seal. Every file defining what Jewel can do is
hashed into a manifest signed with FMB's Ed25519 private key. The runtime
verifies on boot and refuses to act on a mismatch; CI verifies on every push
using the public key alone, so CI can check a build but never sign one.

Re-signing with their own key yields `signed: true, pinned: false` — refused,
because high-risk capability requires a signing key matching a trust anchor
held outside the seal.

**Holds only if:** the anchor is pinned somewhere they do not control
(`JEWEL_SEAL_PUBLIC_KEY` as a CI variable) or FMB compares the fingerprint
`jewel doctor` prints. An attacker who controls the repository can replace
`jewel.pub` as well; against the repository alone that looks self-consistent.
**This residual step cannot be removed by cryptography — only made visible.**

### 4. Replay, duplication and race conditions
**Capability:** can retry requests, interrupt Jewel mid-action, or cause a
provider to time out after it already acted.

**Stopped by:** grants are single-use and expiring; every side effect claims an
idempotency key before running and settles it after; HTTP retries apply only to
idempotent verbs. An attempt that starts and never settles resolves to
`indeterminate` and asks FMB rather than silently retrying.

**Not stopped:** an action that genuinely succeeded at the provider while the
connection dropped. Jewel reports the uncertainty honestly; she cannot resolve
it, and deliberately does not guess.

### 5. Data exfiltration through Jewel's own outputs
**Capability:** tries to get private knowledge into a log, a prompt, an error,
a git commit or an outbound message.

**Stopped by:** redaction on every audit record, log line and API response, by
pattern and by registered secret value; memory refuses to store
credential-shaped content; sensitivity is enforced on read; a test fails the
build if `.env` or `.jewel/` is ever tracked.

**Not stopped:** an approved message that legitimately contains sensitive
content. That is FMB's call, which is what the approval is for.

### 6. Network attacker
**Capability:** sits between Jewel and a provider, or reaches the local API.

**Stopped by:** TLS for provider calls; credentials attached as headers, never
in URLs; the control API binds loopback only, requires a bearer token compared
in constant time, and enforces an origin allowlist so a random web page cannot
drive Jewel through FMB's browser.

**Not stopped:** an attacker already on FMB's machine. They can read the token
from `.env.local`.

## Explicitly out of scope

- **Host compromise.** Assumed fatal. Everything here is downstream of it.
- **A coerced or deceived owner.** Jewel shows exactly what she is about to do;
  she cannot know whether FMB was tricked into approving it.
- **Provider-side compromise.** If Gmail is breached, Jewel's approvals are
  irrelevant.
- **Availability.** No protection against denial of service. Jewel failing
  closed is the intended outcome.
- **Traffic analysis.** Which providers Jewel contacts, and when, is visible.
- **Physical access** to an unlocked machine.

## Where this model is weakest

Stated plainly, in order:

1. **The private key lives in `.env.local` in plaintext.** Anyone with the disk
   or a backup of it has signing authority. OS keychain or a hardware-backed
   key is the real fix; this is the largest single gap.
2. **The trust anchor needs one out-of-band check.** Unavoidable, but currently
   it depends on FMB remembering to compare a fingerprint.
3. **Approval quality depends on the human.** The system makes the payload
   visible; it cannot make anyone read it.
4. **The API token is a bearer token in a file.** Sufficient for a loopback
   control surface, insufficient if Jewel is ever exposed beyond localhost.
5. **Injection detection is best-effort.** By design it is not load-bearing —
   but the warnings it produces should not be mistaken for coverage.
