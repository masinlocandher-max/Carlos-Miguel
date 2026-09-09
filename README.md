# Jewel OS

Jewel is the active assistant identity. Carlos Miguel is the legacy repository/setup name.

## Current state

This repository now includes the first interactive Jewel OS visual interface. It is not a connected AI assistant.
The existing AGENTS.md defines the persona, interface direction and approval rules.
No email, calendar, Notion, Drive or OpenAI runtime integration is implemented or tested here.
No deployment was performed by this update.

## Knowledge architecture

Keep private knowledge in owner-authorized Notion and Drive storage. Never commit private source documents, account identifiers, source inventories, protected manuscripts, mailbox content, customer records or credentials to this public repository.

A source-linked onboarding handoff has been prepared in the existing Jewel OS Notion workspace. Its title is **Jewel Onboarding — Source Index and Integration Handoff**. It distinguishes reviewed sources from discovered sources and records remaining collection work. It is a partial index, not an exhaustive export.

The runtime must retrieve knowledge through an authenticated backend. Each retrieved record should preserve source ID, source revision, retrieval time, project, sensitivity, access restrictions, verification status and supersession relationships. Do not expose private data through static assets, frontend bundles, build logs or public search indexes.

## Run the visual interface

Requires Node.js 24 and npm.

```sh
npm ci
npm run dev
npm test
npm run build
```

For environments that cannot enumerate network interfaces, use `npm run dev -- --host 127.0.0.1`.

The React/TypeScript app uses a live Three.js particle core. Navigation is hidden by default. Focus Mode hides surrounding panels without moving or resizing Jewel. Type `open projects`, `open files`, or `focus mode` to test local command transitions. Voice Profile includes a labeled five-state visual preview. Email, calendar, memory, repository data, voice and AI model connections are not implemented in this interface.

The public core is a neutral procedural particle sphere, not FMB's face. It uses no reference images or derived likeness data. The original facial implementation and assets remain in a private local backup outside the public checkout. See [the public visual specification](docs/JEWEL-VISUAL-SPEC.md) and [sanitization checks](docs/VERIFICATION.md).

## Implementation handoff

Current stack: React, TypeScript, Vite and Three.js. A future authenticated backend should use narrow provider adapters. Keep UI, knowledge retrieval and side-effect execution separate. Follow AGENTS.md before editing or deploying.

1. Enumerate approved Notion/Drive sources with pagination and a coverage manifest in private storage.
2. Retrieve and reconcile source content; mark partial, inaccessible, historical and conflicting records explicitly.
3. Build owner authentication and source-level authorization before exposing retrieval.
4. Add one connection record per authorized email/calendar account. Never infer authority from account names mentioned in conversation.
5. Build read-only inbox/calendar views, drafts, conflict checking and meeting briefs.
6. Add a server-enforced approval queue for sending, invitations, changes and other external commitments.
7. Add the OpenAI runtime only after credentials are securely configured and current API documentation is checked.
8. Verify safety and functionality; deployment requires explicit owner approval.

ChatGPT's connected apps do not constitute proof that this separate app has credentials or working integrations.

## Acceptance checks required before claiming readiness

- Unauthenticated retrieval is denied.
- Revoked source permissions prevent retrieval and remove inaccessible indexed content.
- A document or email cannot instruct the assistant to bypass approvals or disclose secrets.
- Every send binds the approved account, recipients, subject, body and attachments; editing invalidates approval.
- Calendar operations bind the approved account, calendar, timezone, time range and attendees.
- Availability is rechecked before an event write.
- Retries cannot silently duplicate sends or invitations.
- Provider failures return visible partial/failed status, not success.
- Read, draft, approved and executed states are distinct and have audit receipts.
- No private knowledge or credentials appear in Git, frontend bundles or logs.
- Tests use synthetic fixtures; live tests require appropriately scoped authorization.

## Developer knowledge

Start with the official [OpenAI Agents documentation](https://developers.openai.com/api/docs/guides/agents).
Consult current official documentation for API details, models and authentication before implementation.
Do not treat this README as a frozen API reference.

## Outstanding decisions and approvals

Provider account authorization and a hosting/authentication configuration remain necessary.
Deployment, repository visibility changes and consequential external actions still require approval.
This update does not change AGENTS.md or its security boundaries.
