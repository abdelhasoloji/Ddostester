import { expect, it } from 'vitest';
import { validateFleetProgress } from '../src/modules/fleet/progress.js';
it('rejects counter rollbacks and impossible successes', () => {
  const previous = { sent: 10, successful: 8, failed: 2, elapsedSec: 2, actualRps: 5 };
  expect(() => validateFleetProgress({ ...previous, sent: 9 }, previous)).toThrow();
  expect(() => validateFleetProgress({ ...previous, successful: 11 })).toThrow();
  expect(validateFleetProgress({ ...previous, sent: 11, successful: 9 }, previous).sent).toBe(11);
});
