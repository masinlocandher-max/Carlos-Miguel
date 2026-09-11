/**
 * Jewel OS - injectable clock.
 * Every timestamp in the system flows through here so audit records and
 * approval expiry are deterministic under test.
 */

/** @typedef {{ now: () => Date, iso: () => string, ms: () => number }} Clock */

/** @type {Clock} */
export const systemClock = {
  now: () => new Date(),
  iso: () => new Date().toISOString(),
  ms: () => Date.now(),
};

/**
 * Fixed clock for tests and replay.
 * @param {string|number|Date} start
 * @returns {Clock & { advance: (ms: number) => void, set: (t: string|number|Date) => void }}
 */
export function fixedClock(start) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    iso: () => new Date(t).toISOString(),
    ms: () => t,
    advance: (ms) => { t += ms; },
    set: (v) => { t = new Date(v).getTime(); },
  };
}
