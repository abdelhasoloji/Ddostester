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

export function remoteProbeQualityReasons(quality?: {
  measuredSamples: number;
  totalSamples: number;
  peakEventLoopDelayMs: number | null;
  peakRecentEventLoopDelayMs?: number | null;
  eventLoopMeasuredSamples?: number;
  peakThrottledFraction: number | null;
}): string[] {
  const reasons: string[] = [];
  if (
    !quality ||
    quality.totalSamples === 0 ||
    quality.measuredSamples / quality.totalSamples < 0.9
  )
    reasons.push(
      'Remote probe resource diagnostics cover less than 90% of measurements; probe contention is not ruled out.',
    );
  if (
    quality &&
    ((quality.peakEventLoopDelayMs === null && quality.peakRecentEventLoopDelayMs == null) ||
      quality.peakThrottledFraction === null)
  )
    reasons.push(
      'Some remote probe event-loop or cgroup diagnostics are unavailable; resource health remains partially unknown.',
    );
  if (
    quality?.eventLoopMeasuredSamples !== undefined &&
    quality.totalSamples > 0 &&
    quality.eventLoopMeasuredSamples / quality.totalSamples < 0.9
  )
    reasons.push(
      'Remote probe event-loop diagnostics cover less than 90% of measurements; local contention remains uncertain.',
    );
  if (Math.max(quality?.peakEventLoopDelayMs ?? 0, quality?.peakRecentEventLoopDelayMs ?? 0) > 100)
    reasons.push(
      'Remote probe event-loop delay exceeded 100ms; local probe contention may affect measurements.',
    );
  if ((quality?.peakThrottledFraction ?? 0) > 0.1)
    reasons.push(
      'Remote probe cgroup throttling exceeded 10% of its measurement interval; this does not attribute a slowdown to the target.',
    );
  return reasons;
}

/** Diagnostic threshold, not a correction of target scores: >10% throttled time. */
export function fleetCpuContention(shards: { result?: Record<string, unknown> }[] = []): boolean {
  return shards.some((shard) => {
    const resource = shard.result?.resources as Record<string, unknown> | undefined;
    if (resource?.schema !== 'ddostester.fleet.resources/v1') return false;
    const elapsed = resource.elapsedMs;
    const throttled = resource.cgroupThrottledUsecDelta;
    return (
      typeof elapsed === 'number' &&
      Number.isFinite(elapsed) &&
      elapsed > 0 &&
      typeof throttled === 'number' &&
      Number.isFinite(throttled) &&
      throttled >= 0 &&
      throttled / (elapsed * 1000) > 0.1
    );
  });
}

export function computeConfidence(input: {
  unfinalizedRequests?: number;
  fleetCpuContention?: boolean;
  fleetIncomplete?: boolean;
  hardStopped?: boolean;
  peakEventLoopLagMs?: number;
  /** Whether the run ended in an automatic (probe-driven) kill. */
  killedAuto?: boolean;
  /** Total requests the generator managed to send during the run. */
  generatorRequests?: number;
}): RunConfidence {
  const reasons: string[] = [];
  if ((input.unfinalizedRequests ?? 0) > 0)
    reasons.push(
      'Started generator attempts lack finalized HTTP outcomes; their target receipt and status remain uncertain.',
    );
  if (input.fleetCpuContention)
    reasons.push(
      'An agent cgroup reported CPU throttling exceeding 10% of its measured wall time. Generator resource contention may limit delivered load; this diagnostic does not attribute the shortfall to the target.',
    );
  if (input.fleetIncomplete)
    reasons.push(
      'Distributed evidence is incomplete: one or more agents stopped or failed to provide a final measurement. This is not a complete resilience result.',
    );
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
  // A self-inflicted auto-kill: the probe declared the target unavailable WHILE
  // our own event loop was stalling and the generator barely made progress. The
  // probe shares the event loop with the generator, so its "unavailable" reading
  // reflects OUR stall, not the target — the auto-kill (and any low WRS from it)
  // is not attributable to the target. Re-run out-of-process before trusting it.
  if (
    input.killedAuto &&
    peak > EVENT_LOOP_LAG_DEGRADED_MS &&
    (input.generatorRequests ?? 0) < 50
  ) {
    reasons.push(
      'Auto-kill is likely generator-side, NOT a target failure: the probe read the target as unavailable while the generator stalled its own event loop and sent almost no load. Re-run on an out-of-process engine (vegeta/k6) before trusting this verdict.',
    );
  }
  return {
    degraded: reasons.length > 0,
    reasons,
    peakEventLoopLagMs: input.peakEventLoopLagMs,
  };
}
