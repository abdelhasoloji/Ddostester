export interface ProbeQuality {
  schema: 'ddostester.probe.quality/v1';
  scope: 'process-during-measurement';
  elapsedMs: number;
  cpuUserUsec: number;
  cpuSystemUsec: number;
  rssBytes: number;
  eventLoopDelayMaxMs: number | null;
  cgroupThrottledUsecDelta: number | null;
  sampledAt: string;
  recentEventLoop?: null | {
    scope: 'process-recent-window';
    windowMs: number;
    samples: number;
    maxMs: number;
  };
}
export function validateProbeQuality(value: unknown): ProbeQuality | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid probe quality');
  const q = value as Record<string, unknown>;
  const bounded = (v: unknown, maximum: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= maximum;
  const recent = q.recentEventLoop as Record<string, unknown> | null | undefined;
  if (
    recent !== undefined &&
    recent !== null &&
    (typeof recent !== 'object' ||
      recent.scope !== 'process-recent-window' ||
      !bounded(recent.windowMs, 120_000) ||
      !Number.isSafeInteger(recent.samples) ||
      (recent.samples as number) < 1 ||
      (recent.samples as number) > 1e7 ||
      !bounded(recent.maxMs, 120_000))
  )
    throw new Error('Invalid probe quality recent window');
  if (
    q.schema !== 'ddostester.probe.quality/v1' ||
    q.scope !== 'process-during-measurement' ||
    !bounded(q.elapsedMs, 120_000) ||
    !bounded(q.cpuUserUsec, 1e12) ||
    !bounded(q.cpuSystemUsec, 1e12) ||
    !bounded(q.rssBytes, 1e12) ||
    !(q.eventLoopDelayMaxMs === null || bounded(q.eventLoopDelayMaxMs, 120_000)) ||
    !(q.cgroupThrottledUsecDelta === null || bounded(q.cgroupThrottledUsecDelta, 1e12)) ||
    typeof q.sampledAt !== 'string' ||
    q.sampledAt.length !== 24 ||
    !Number.isFinite(Date.parse(q.sampledAt))
  )
    throw new Error('Invalid probe quality');
  return {
    schema: q.schema,
    scope: q.scope,
    elapsedMs: q.elapsedMs as number,
    cpuUserUsec: q.cpuUserUsec as number,
    cpuSystemUsec: q.cpuSystemUsec as number,
    rssBytes: q.rssBytes as number,
    eventLoopDelayMaxMs: q.eventLoopDelayMaxMs as number | null,
    cgroupThrottledUsecDelta: q.cgroupThrottledUsecDelta as number | null,
    sampledAt: q.sampledAt,
    ...(recent === undefined
      ? {}
      : {
          recentEventLoop:
            recent === null
              ? null
              : {
                  scope: 'process-recent-window' as const,
                  windowMs: recent.windowMs as number,
                  samples: recent.samples as number,
                  maxMs: recent.maxMs as number,
                },
        }),
  };
}

export interface ProbeQualitySummary {
  latest?: ProbeQuality;
  measuredSamples: number;
  totalSamples: number;
  peakEventLoopDelayMs: number | null;
  peakRecentEventLoopDelayMs: number | null;
  eventLoopMeasuredSamples: number;
  peakThrottledFraction: number | null;
}
/** Same accounting for baseline and load; overlapping process windows are not independent costs. */
export function summarizeProbeQuality(
  quality: ProbeQuality[],
  totalSamples: number,
): ProbeQualitySummary {
  const delays = quality.flatMap((sample) =>
    sample.eventLoopDelayMaxMs === null ? [] : [sample.eventLoopDelayMaxMs],
  );
  const recent = quality.flatMap((sample) =>
    sample.recentEventLoop ? [sample.recentEventLoop.maxMs] : [],
  );
  const throttling = quality.flatMap((sample) =>
    sample.cgroupThrottledUsecDelta === null || sample.elapsedMs <= 0
      ? []
      : [sample.cgroupThrottledUsecDelta / (sample.elapsedMs * 1000)],
  );
  return {
    measuredSamples: quality.length,
    totalSamples,
    ...(quality.length ? { latest: quality[quality.length - 1] } : {}),
    peakEventLoopDelayMs: delays.length ? Math.max(...delays) : null,
    peakRecentEventLoopDelayMs: recent.length ? Math.max(...recent) : null,
    eventLoopMeasuredSamples: quality.filter(
      (sample) => sample.eventLoopDelayMaxMs !== null || sample.recentEventLoop,
    ).length,
    peakThrottledFraction: throttling.length ? Math.max(...throttling) : null,
  };
}
