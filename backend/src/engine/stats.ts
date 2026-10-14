/** Percentile of a pre-sorted numeric array (nearest-rank), rounded to 2 dp. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, idx)].toFixed(2));
}

export interface LatencyHistogram {
  boundsMs: number[];
  /** Non-cumulative buckets; final entry is overflow. */
  counts: number[];
  count: number;
  sumMs: number;
}
export function latencyHistogram(
  values: readonly number[],
  boundsMs: readonly number[],
): LatencyHistogram {
  const counts = Array.from({ length: boundsMs.length + 1 }, () => 0);
  let sumMs = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid latency sample');
    const index = boundsMs.findIndex((bound) => value <= bound);
    counts[index < 0 ? boundsMs.length : index]++;
    sumMs += value;
  }
  return { boundsMs: [...boundsMs], counts, count: values.length, sumMs };
}
