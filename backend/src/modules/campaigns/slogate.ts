/**
 * SLO gate (EPIC C): turns a bounded campaign's result into a CI pass/fail so
 * resilience becomes a delivery criterion, not an after-the-fact report. Pure
 * and engine-agnostic — it evaluates metrics we already collect and generates
 * no traffic. The CI wiring (`cli/slogate.ts` + the workflow) runs a *bounded*
 * campaign against a lab target that is in the server's allowlist.
 */

import { evaluateAcceptance } from './acceptance.js';
import type { AcceptanceCriteria, AcceptanceMetrics } from './acceptance.js';
import type { CampaignRun } from './runner.js';

export interface SloGateConfig extends AcceptanceCriteria {
  /**
   * Fail only if WRS dropped MORE than this many points vs. the previous run.
   * A tolerance band so normal measurement noise doesn't fail a PR. Omit to
   * disable the regression check.
   */
  regressionTolerancePoints?: number;
}

export interface SloGateVerdict {
  verdict: 'PASS' | 'FAIL';
  pass: boolean;
  reasons: string[];
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Derives the acceptance metrics from a finished run (same math as the runner). */
export function metricsFromRun(run: CampaignRun): AcceptanceMetrics {
  const g = run.generator;
  const total = g.totalRequests;
  const checked = g.assertionsChecked ?? 0;
  return {
    p95Ms: g.latencyMs.p95,
    errorRatePct: total > 0 ? (g.failed / total) * 100 : 0,
    availabilityPct: run.probe.samples ? (run.probe.available / run.probe.samples) * 100 : 100,
    wrs: run.wrs.wrs,
    assertionFailurePct: checked > 0 ? ((g.assertionFailures ?? 0) / checked) * 100 : 0,
  };
}

/**
 * Evaluates the SLO gate: the acceptance thresholds plus an optional WRS
 * regression check against the previous run, within a tolerance band.
 */
export function evaluateSloGate(
  metrics: AcceptanceMetrics,
  config: SloGateConfig,
  previousWrs?: number,
): SloGateVerdict {
  const reasons: string[] = [];
  const acc = evaluateAcceptance(config, metrics);
  if (acc) reasons.push(...acc.failures);

  if (
    config.regressionTolerancePoints != null &&
    previousWrs != null &&
    previousWrs - metrics.wrs > config.regressionTolerancePoints
  ) {
    reasons.push(
      `WRS regression ${round(previousWrs - metrics.wrs)} pts > tolerance ${config.regressionTolerancePoints} (prev ${previousWrs} → ${round(metrics.wrs)})`,
    );
  }

  const pass = reasons.length === 0;
  return { verdict: pass ? 'PASS' : 'FAIL', pass, reasons };
}

/** Reads the SLO gate configuration from the environment. */
export function sloGateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SloGateConfig {
  const num = (v?: string): number | undefined =>
    v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  return {
    minWrs: num(env.SLO_MIN_WRS),
    maxP95Ms: num(env.SLO_MAX_P95_MS),
    maxErrorRatePct: num(env.SLO_MAX_ERROR_RATE_PCT),
    minAvailabilityPct: num(env.SLO_MIN_AVAILABILITY_PCT),
    maxAssertionFailurePct: num(env.SLO_MAX_ASSERTION_FAILURE_PCT),
    regressionTolerancePoints: num(env.SLO_REGRESSION_TOLERANCE_PTS),
  };
}
