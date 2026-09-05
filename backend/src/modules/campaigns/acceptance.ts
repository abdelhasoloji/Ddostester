/**
 * Acceptance criteria (SLO pass/fail): turns a run's measurements into an
 * explicit PASS/FAIL verdict against operator-defined thresholds — the missing
 * link between "we measured" and "the target is resilient". Pure and
 * engine-agnostic: it evaluates metrics we already collect, so it works for
 * every load engine. It generates no traffic.
 */

export interface AcceptanceCriteria {
  /** Max acceptable generator latency p95 (ms). */
  maxP95Ms?: number;
  /** Max acceptable generator error rate (%). */
  maxErrorRatePct?: number;
  /** Min acceptable probe availability during the run (%). */
  minAvailabilityPct?: number;
  /** Min acceptable WRS. */
  minWrs?: number;
  /** Max acceptable response-assertion failure rate (%). */
  maxAssertionFailurePct?: number;
}

export interface AcceptanceResult {
  verdict: 'PASS' | 'FAIL';
  /** Human-readable descriptions of the criteria that were not met. */
  failures: string[];
}

/** Measured values a verdict is evaluated against. */
export interface AcceptanceMetrics {
  p95Ms: number;
  errorRatePct: number;
  availabilityPct: number;
  wrs: number;
  /** Response-assertion failure rate (%); 0 when no assertion was set. */
  assertionFailurePct: number;
}

/** True if at least one criterion is set. */
export function hasCriteria(c?: AcceptanceCriteria): boolean {
  return (
    !!c &&
    (c.maxP95Ms != null ||
      c.maxErrorRatePct != null ||
      c.minAvailabilityPct != null ||
      c.minWrs != null ||
      c.maxAssertionFailurePct != null)
  );
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Evaluates the criteria against measured metrics. Returns null when no
 * criteria are set (nothing to assert).
 */
export function evaluateAcceptance(
  c: AcceptanceCriteria | undefined,
  m: AcceptanceMetrics,
): AcceptanceResult | null {
  if (!hasCriteria(c)) return null;
  const failures: string[] = [];
  if (c!.maxP95Ms != null && m.p95Ms > c!.maxP95Ms) {
    failures.push(`p95 latency ${round(m.p95Ms)}ms > ${c!.maxP95Ms}ms`);
  }
  if (c!.maxErrorRatePct != null && m.errorRatePct > c!.maxErrorRatePct) {
    failures.push(`error rate ${round(m.errorRatePct)}% > ${c!.maxErrorRatePct}%`);
  }
  if (c!.minAvailabilityPct != null && m.availabilityPct < c!.minAvailabilityPct) {
    failures.push(`availability ${round(m.availabilityPct)}% < ${c!.minAvailabilityPct}%`);
  }
  if (c!.minWrs != null && m.wrs < c!.minWrs) {
    failures.push(`WRS ${round(m.wrs)} < ${c!.minWrs}`);
  }
  if (c!.maxAssertionFailurePct != null && m.assertionFailurePct > c!.maxAssertionFailurePct) {
    failures.push(
      `assertion failures ${round(m.assertionFailurePct)}% > ${c!.maxAssertionFailurePct}%`,
    );
  }
  return { verdict: failures.length ? 'FAIL' : 'PASS', failures };
}
