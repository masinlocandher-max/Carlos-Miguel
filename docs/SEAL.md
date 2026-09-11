# The Capability Seal

## What this actually protects — read this first

The seal does **not** make files unwritable. Anyone with write access to this
repository can edit any file in it. Nobody can build a system that prevents
that, and any tool that claims otherwise is lying to you.

What the seal does is make a modified Jewel **unusable and undeniable**:

1. Every file in the capability surface is hashed with SHA-256.
2. The sorted `(path, hash)` manifest is hashed into a single **root digest**.
3. The root digest is signed with HMAC-SHA256 under `JEWEL_SEAL_KEY` — a secret
   only you hold, never committed, never in this repository.
4. The runtime verifies the manifest on **every boot**. One changed byte changes
   the root digest, the signature stops matching, and Jewel refuses to act.
5. CI re-verifies on every push and pull request, so a tampered core cannot
   reach `main` quietly.

So another builder can fork Jewel and gut her. What they cannot do is produce a
build that passes verification **and** still acts on your accounts. Modification
is not prevented; it is made visible and inert.

## The three states

| State | What it means | What Jewel can do |
|---|---|---|
| **Signed** | Hashes match and your signature verifies | Everything, including high-risk gated actions |
| **Unsigned** | Hashes match, no valid owner signature | Read, draft, remember, organize. **No high-risk action** |
| **Broken** | A sealed file changed, was deleted, or the digest is wrong | **Lockdown.** Only diagnostics run |

The repository ships **unsigned** on purpose. The committed `SEAL.json` carries
no signature, because a signature committed to a public repository would be
worthless. You create the real one.

## First-time setup (do this once)

Generate a key and keep it somewhere only you can reach — a password manager,
not a file in this repo, not a note, not chat history.

```bash
# Generate a strong key
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

# Seal with it
export JEWEL_SEAL_KEY=<the key you just generated>
npm run seal
npm run verify      # should say: verified and owner-signed
```

Then commit the updated `SEAL.json`. It contains hashes and a signature — no
secret. The key itself never leaves your hands.

Add the same key as a repository secret named `JEWEL_SEAL_KEY` so CI verifies
the signature too. Without it CI still checks the hashes and warns.

## Re-sealing after an approved change

Any change to a sealed file requires a re-seal. That friction is the feature —
it is the moment you decide whether the change to Jewel's capability is one you
actually want.

```bash
npm run verify                 # shows exactly which files changed
npm test                       # the suite must pass before you seal
JEWEL_SEAL_KEY=... npm run seal
npm run verify                 # verified and owner-signed
```

Each seal records the digest of the one it replaced (`previousRoot`) and a
`sealNumber`, so the chain of custody is auditable: you can always see how many
times the capability surface has changed and what it was before.

## What is sealed

Run `node tools/seal-cli.mjs status` for the live list. It covers:

- `src/core/**` — constitution, policy, approvals, idempotency, audit, memory,
  the executor, the registry and the kernel
- `src/tools/index.js` — **every capability's risk tier and approval gate**
- `src/adapters/**` — the only code that reaches the outside world
- `src/runtime/config.js` and `jewel.mjs` — the boot surface

`src/tools/index.js` matters more than it looks. It is where `email.send` is
declared high-risk and gated. Leaving it unsealed would let someone quietly
drop that gate without breaking verification.

## Honest limits

- **A fork can delete the check.** Someone can remove `verifySeal` from
  `kernel.js` entirely. Then CI fails, the file hash no longer matches, and
  what they are running is not Jewel — it is their own program wearing her name.
  The seal makes that a visible choice, not a silent one.
- **The key is the whole thing.** If `JEWEL_SEAL_KEY` leaks, someone else can
  sign a modified core. Treat it like the key to your accounts, because
  functionally it is.
- **HMAC means you verify with the same key you sign with.** That is fine for a
  single owner. If you ever need others to verify without being able to sign,
  that requires asymmetric signatures (Ed25519) — a straightforward change to
  `integrity.js`, and one that would need a re-seal.
- **The seal protects capability, not data.** Your Notion content, Drive files
  and mailbox are protected by the approval gates and the redaction layer, not
  by this.
