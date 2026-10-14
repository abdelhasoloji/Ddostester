import { LATENCY_BUCKETS_MS } from '../../config/limits.js';
import type { LatencyHistogram } from '../../engine/stats.js';

/** No averaging percentiles: merge observations on identical bucket boundaries. */
export function mergeHistograms(histograms: LatencyHistogram[]): LatencyHistogram {
  const counts = Array.from({ length: LATENCY_BUCKETS_MS.length + 1 }, () => 0);
  let count = 0;
  let sumMs = 0;
  for (const h of histograms) {
    if (
      JSON.stringify(h.boundsMs) !== JSON.stringify(LATENCY_BUCKETS_MS) ||
      h.counts.length !== counts.length ||
      !h.counts.every((x) => Number.isSafeInteger(x) && x >= 0) ||
      !Number.isSafeInteger(h.count) ||
      h.count < 0 ||
      h.counts.reduce((a, b) => a + b, 0) !== h.count ||
      !Number.isFinite(h.sumMs) ||
      h.sumMs < 0
    )
      throw new Error('Incompatible or invalid histogram');
    count += h.count;
    sumMs += h.sumMs;
    h.counts.forEach((value, i) => {
      counts[i] += value;
    });
  }
  if (!Number.isSafeInteger(count) || !Number.isFinite(sumMs))
    throw new Error('Histogram overflow');
  return { boundsMs: [...LATENCY_BUCKETS_MS], counts, count, sumMs };
}
/** Upper bucket bound, not an exact percentile; null means absent or overflow. */
export function percentileUpperBound(histogram: LatencyHistogram, percent: number): number | null {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
    throw new Error('Invalid percentile');
  const merged = mergeHistograms([histogram]);
  if (!merged.count) return null;
  const rank = Math.ceil((merged.count * percent) / 100);
  let sum = 0;
  for (let i = 0; i < merged.counts.length; i++) {
    sum += merged.counts[i];
    if (sum >= rank) return merged.boundsMs[i] ?? null;
  }
  return null;
}
