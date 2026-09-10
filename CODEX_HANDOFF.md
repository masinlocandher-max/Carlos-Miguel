# Jewel OS public implementation handoff

## Branch and foundation

`codex/jewel-command-center`, rebuilt directly from `foundation/jewel-clean-base`.

The original facial implementation is preserved in an external local Git bundle. The two asset-bearing commits are not ancestors of this public branch. Never push backup refs, all refs, or the bundle.

## Preserved implementation

React, TypeScript, Vite, Three.js particle and filament rendering, rings, orbitals, scans, five continuous states, hidden-by-default navigation, Focus Mode, responsive behavior, local command transitions, reduced-motion and Canvas fallback support.

The public build uses a neutral sphere computed from mathematical formulas. No facial references, portrait previews, derived likeness binary data or reference-specific generator are included. The face is intentionally unavailable in this sanitized branch.

## Commands

`npm ci`, `npm run dev`, `npm test`, `npm run build`.

Example local input: `open files`, `open projects`, `focus mode`.

## Delivery boundary

The owner authorized only the sanitized branch push. Do not merge, deploy or change repository visibility. No provider integration or live private data is implemented. See `docs/VERIFICATION.md` for publication checks.

## Visual shell freeze candidate

Final refinement continues from sanitized baseline `f0ce32856518d882f4e9515c8a62b9ec007693d1`.

- Caption, actions, notices and command input share a vertical stack. Notices replace redundant caption/actions. The original laptop collision is corrected without changing Jewel stage bounds.
- Essential narrow-screen typography and keyboard focus visibility are improved. Focus Mode suppresses secondary chrome and preserves exact core bounds.
- Existing scan/filament opacity and Canvas fallback luminance are refined. No renderer architecture, state timing, performance mechanism or private identity changed.
- Narrow context panels reserve the measured command-stack height plus a 12px gap while a notice is present. ResizeObserver tracks wrapping/resizing and disconnects on unmount. Dismiss targets are 44px; normal panel spacing returns after dismissal.
- `tests/browser.cjs` provides focused production-preview checks for stack overlap, narrow notice clearance and dismissal, restored spacing, keyboard navigation focus, Focus bounds, five-state local commands and absence of private/external requests. No screenshots are committed.

Verification: all four unit tests and TypeScript/Vite build pass. Focused Chromium regressions pass at 1920x1080, 1440x900, 1366x768 and 390x844. The 532kB lazy renderer advisory remains nonblocking. Desktop hardware 60fps and Safari/Firefox are not certified.

Run browser checks with `npm ci`, `npx playwright install chromium`, `npm run build`, then `npm run test:browser`. CI installs Chromium system dependencies. Optional `JEWEL_BROWSER_EXECUTABLE` and JSON `JEWEL_BROWSER_ARGS` support an existing local browser; `JEWEL_QA_OUTPUT` captures local-only evidence outside the repository.

This milestone ends at the freeze candidate. No merge, deployment, API integration or private asset restoration is authorized by it. Do not begin another visual or runtime milestone without a new task.
