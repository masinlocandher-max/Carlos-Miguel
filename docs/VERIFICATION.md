# Sanitized Jewel verification

The public branch is rebuilt from the clean foundation, not from either asset-bearing implementation commit. The complete former implementation is preserved in an external local Git bundle and private asset copies.

## Required publication checks

- Inspect every tree in the new branch's reachable history, including base history.
- Reject former sensitive paths, image/binary asset files and the reference-specific generator.
- Check that none of the known sensitive blob IDs is reachable, even under a renamed path.
- Verify the former implementation commits are not ancestors.
- Check source and production output for old asset paths, injected payloads or asset requests.
- Run TypeScript/Vite build and local routing/procedural geometry tests.
- Push only the explicit sanitized branch ref, without tags or other branches.

The public geometry is a neutral formula-generated sphere. All likeness-specific acceptance claims from the private build are withdrawn for this public build. Original private visual screenshots and performance measurements are not shipped as evidence of the sanitized renderer. Desktop hardware 60 fps remains unverified.

Vite may report a bundle-size advisory for the separately lazy-loaded Three.js renderer. This is not a build error.

## Sanitized build results

- Four tests pass, including deterministic neutral geometry generation without private files or network.
- TypeScript and clean Vite production build pass; only the lazy renderer bundle-size advisory remains.
- Chromium smoke check passes: neutral WebGL core, no likeness asset requests or image/video core, closed navigation, fixed Focus Mode bounds, all five local command states in order, and no page errors.
- Stale generated output from the private build was removed from this checkout before rebuilding; the previous output is preserved only in the external private backup.
- Removed from public source: four reference JPEGs, two likeness preview PNGs, two derived geometry binaries, the private geometry metadata JSON, and the reference-specific Python generator.
