# Getting Jewel running

Node 22 or newer. Nothing else is required for the runtime.

## 1. Set up (once)

```bash
node jewel.mjs init
```

This generates your seal key and API token, writes `.env.local` (gitignored,
mode 600) with everything else pre-filled, and seals the core with your key.

**Copy the seal key it prints into your password manager now.** It is printed
once. Without it you cannot re-seal the core, and Jewel refuses high-risk
actions on an unsigned core.

```bash
node jewel.mjs doctor
```

`doctor` lists exactly what is still missing. Work down that list.

## 2. Give her a model

Open `.env.local` and replace one placeholder with a real key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Without a model key Jewel says so plainly rather than inventing answers.

## 3. Say who she may act as

```
JEWEL_ACCOUNTS=you@yourdomain.com
```

This matters more than it looks. Jewel will **never** infer authority from an
address mentioned in conversation — not from an email signature, not from a
Notion page, not from something you typed in a hurry. If it is not on this
list, she will not act as it.

## 4. Connect a workspace (optional, as you go)

```
NOTION_API_KEY=...
GITHUB_TOKEN=...
GOOGLE_ACCESS_TOKEN=...
```

An unconnected provider throws rather than returning nothing, so "not
connected" can never be mistaken for "nothing found".

## 5. Use her

**From the terminal:**

```bash
node jewel.mjs ask "what needs my attention today"
node jewel.mjs approvals
node jewel.mjs show <ref>        # the exact payload an approval unlocks
node jewel.mjs approve <ref>
```

**From the command centre:**

```bash
npm ci && npm run build     # once
node jewel.mjs serve        # terminal 1 — the runtime
npm run dev                 # terminal 2 — the interface
```

## 6. Going live

Jewel starts in **dry run**. Nothing reaches the outside world — sends are
simulated, and she says so every time.

Stay there until you have watched her work and you trust what she proposes.
When you are ready:

```
JEWEL_EXECUTION_MODE=live
```

Even in live mode, every consequential action still stops and waits for you.

---

## The approval loop, which is the whole point

When Jewel wants to do something consequential, she stops:

```
pending_approval: Waiting on FMB. Approval 9FA8E888AA: SEND "October timeline" to client@example.com
```

Before you decide, look at exactly what you are approving:

```bash
node jewel.mjs show 9FA8E888AA
```

That prints the full payload — every recipient, the subject, the sending
account. Approve it and she carries out **that exact thing, once**. Change a
single character afterwards and the approval no longer applies; she will stop
and ask again.

Ask her to repeat something already done and she tells you it is done rather
than doing it twice.

---

## When something is wrong

| Symptom | What it means | What to do |
|---|---|---|
| `Capability seal BROKEN` | A sealed file changed | `npm run verify` names the file. If the change was yours and intended, re-seal. If not, investigate before anything else |
| `Only diagnostics run` | Lockdown from a broken seal | Same as above. Jewel will explain but not act |
| `high-risk actions are disabled` | The core is not owner-signed | `JEWEL_SEAL_KEY=... npm run seal` |
| `Jewel's runtime is not reachable` | The API is not running | `node jewel.mjs serve` |
| `token was rejected` | UI and runtime tokens differ | `VITE_JEWEL_API_TOKEN` must equal `JEWEL_API_TOKEN` |
| `indeterminate` action | An attempt started and never reported back | The effect may or may not have happened. Check the provider yourself. Jewel will not retry on her own, by design |
| `AUDIT CHAIN BROKEN at record N` | The ledger was altered | Records after N cannot be trusted. Treat as a security incident |

## Checking her work

```bash
node jewel.mjs audit                 # is the ledger intact
node jewel.mjs audit <trace-id>      # every step behind one answer
```

Every answer ends with a trace id. Nothing she does is unaccounted for.
