import type { ScenarioPhase } from '../../engine/types.js';

/**
 * Closed-loop rate calibration (GEN-1) — pure decision logic.
 *
 * A DRS line configured at an aspirational rate (e.g. an 800-rps multi-vector
 * composite, or a 1000-rps synchronized pulse) can exceed what the generator can
 * actually deliver against the target on a single box. The old behaviour ran the
 * graded measurement anyway and silently under-delivered — the assessment engine
 * then (correctly) marked it INCONCLUSIVE, wasting the test.
 *
 * Calibration instead runs a short pre-flight burst on the SAME engine + target,
 * measures the rate it can truly sustain, and grades at that rate. The result is
 * always a VALID measurement (delivered ~100% of what it offered) at the honest
 * maximum the box can produce — never a guessed rate. It only ever LOWERS the
 * offered rate; it can never raise it above what the operator requested.
 */

export interface CalibrationResult {
  /** The peak rate the line asked for (the DRS target rate). */
  requestedRps: number;
  /** The rate the pre-flight burst actually delivered against the target. */
  deliveredRps: number;
  /** The rate the graded run will offer (≤ requested). */
  appliedRps: number;
  /** True when the graded rate was lowered from the requested one. */
  calibrated: boolean;
}

/**
 * If the burst already delivered at least this fraction of the requested rate,
 * the line delivers fine — keep the requested rate (don't needlessly lower a
 * rate that is within the assessment's delivery tolerance).
 */
export const CALIBRATION_KEEP_THRESHOLD = 0.9;

/**
 * Safety margin applied to the measured deliverable ceiling: grade slightly below
 * what a short burst peaked at, so the longer graded run sustains ~100% of the
 * offered rate rather than sitting exactly on the ceiling.
 */
export const CALIBRATION_SAFETY = 0.95;

/**
 * Decide the graded rate from a calibration burst's measured throughput. Pure.
 *
 * - deliveredRps ≥ KEEP_THRESHOLD × requestedRps → keep the requested rate.
 * - otherwise → grade at floor(deliveredRps × SAFETY), clamped to [1, requested].
 *
 * A zero/absent measurement (the burst produced nothing we can trust) is treated
 * as "keep requested" — calibration must never make a line offer nothing.
 */
export function calibratedRate(
  requestedRps: number,
  deliveredRps: number,
  keepThreshold = CALIBRATION_KEEP_THRESHOLD,
  safety = CALIBRATION_SAFETY,
): CalibrationResult {
  const req = Math.max(1, Math.round(requestedRps));
  const delivered = Math.max(0, Math.round(deliveredRps));
  // Not enough signal, or the burst held its rate → run at the requested rate.
  if (delivered <= 0 || delivered >= keepThreshold * req) {
    return { requestedRps: req, deliveredRps: delivered, appliedRps: req, calibrated: false };
  }
  const applied = Math.min(req, Math.max(1, Math.floor(delivered * safety)));
  return { requestedRps: req, deliveredRps: delivered, appliedRps: applied, calibrated: true };
}

/**
 * Scale a load scenario's phase rates by `factor`, preserving its SHAPE (the
 * relative rise/fall of a ramp or pulse) at a deliverable amplitude. Each phase
 * rate is floored at 1 rps and never rounds above its original. Pure.
 */
export function scaleScenario(phases: ScenarioPhase[], factor: number): ScenarioPhase[] {
  const f = Math.max(0, Math.min(1, factor));
  return phases.map((p) => ({
    ...p,
    maxRps: Math.max(1, Math.min(p.maxRps, Math.round(p.maxRps * f))),
  }));
}

/** The peak offered rate of a scenario (max phase rate), or the flat maxRps. */
export function peakRps(maxRps: number, phases?: ScenarioPhase[]): number {
  return phases?.length ? Math.max(...phases.map((p) => p.maxRps)) : maxRps;
}
