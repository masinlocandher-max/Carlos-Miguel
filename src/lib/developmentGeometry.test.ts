import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevelopmentGeometry } from '../visual/developmentGeometry.ts';
test('neutral geometry is deterministic, finite and independent of private files or network', () => {
  const a = createDevelopmentGeometry();
  const b = createDevelopmentGeometry();
  assert.deepEqual(a, b);
  assert.equal(a.values.length, 12000 * 6);
  assert(a.filamentValues.length > 0);
  assert([...a.values, ...a.filamentValues].every(Number.isFinite));
  for (let i = 0; i < a.values.length; i += 6) {
    assert(Math.abs(a.values[i]) <= 0.78);
    assert(Math.abs(a.values[i + 1]) <= 0.78);
    assert(Math.abs(a.values[i + 2]) <= 0.38);
  }
});
