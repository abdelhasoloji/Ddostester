/**
 * Measurement confidence: does a run's WRS reflect the TARGET's protection, or
 * was the generator host itself the bottleneck? A WRS measured while our own
 * event loop was stalling (or a run force-settled by the hard backstop) may
 * understate achieved load and mislead — so we badge it as "degraded" rather
 * than present it as a clean result.
 */

/**
 * Event-loop lag (ms) above which a run's measurement is flagged as possibly
 * generator-limited. Normal idle lag is <5ms; sustained lag above this during a
 * run means the generator host, not the target, may be the constraint.
 */
export const EVENT_LOOP_LAG_DEGRADED_MS = 100;

/**
 * Event-loop lag (ms) above which the scheduler refuses to START a new run — a
 * measurement taken on a saturated generator is not trustworthy, so we defer.
 */
export const EVENT_LOOP_LAG_GUARD_MS = 250;

export interface RunConfidence {
  degraded: boolean;
  reasons: string[];
  peakEventLoopLagMs?: number;
}

export function computeConfidence(input: {
  hardStopped?: boolean;
  peakEventLoopLagMs?: number;
}): RunConfidence {
  const reasons: string[] = [];
  if (input.hardStopped) {
    reasons.push(
      'Run force-settled by the hard backstop (the target held connections open past the cap) — achieved load may be understated.',
    );
  }
  const peak = input.peakEventLoopLagMs ?? 0;
  if (peak > EVENT_LOOP_LAG_DEGRADED_MS) {
    reasons.push(
      `Generator event-loop lag peaked at ${Math.round(peak)}ms during the run — the generator host may have been the bottleneck, not the target.`,
    );
  }
  return {
    degraded: reasons.length > 0,
    reasons,
    peakEventLoopLagMs: input.peakEventLoopLagMs,
  };
}
