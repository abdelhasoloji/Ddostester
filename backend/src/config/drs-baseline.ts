/**
 * Minimum DRS baseline window.
 *
 * The archived standard expects a five-minute observation of a healthy service before
 * injection. That is the right default and it stays a refusal, not a warning. A prototype
 * or a lab with a synthetic target may lower it deliberately through
 * `DRS_BASELINE_FLOOR_SEC`, and the plan still records the value it was frozen with, so a
 * reader can see that the baseline was shorter than the standard expects.
 */
const STANDARD_FLOOR_SEC = 300;

export function drsBaselineFloorSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DRS_BASELINE_FLOOR_SEC);
  if (!Number.isFinite(raw) || raw <= 0) return STANDARD_FLOOR_SEC;
  return Math.min(Math.max(5, Math.floor(raw)), STANDARD_FLOOR_SEC);
}

export const DRS_STANDARD_BASELINE_SEC = STANDARD_FLOOR_SEC;
