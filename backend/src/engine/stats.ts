/** Percentile of a pre-sorted numeric array (nearest-rank), rounded to 2 dp. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
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

/**
 * Streaming latency recorder for the generator's hot path.
 *
 * The built-in engine used to keep every sample in a plain array and sort a copy
 * of it once per second to feed the live drawer. That is O(n log n) per tick,
 * on the same event loop that drives the flood: 135k samples at 150 rps over the
 * 15-minute ceiling, and 1.8M at the 2,000 rps ceiling. The tick then shows up
 * in the run's own event-loop-lag guard and corrupts the measurement it is
 * reporting.
 *
 * Ingest here is O(1) (append into a Float64Array plus one histogram bucket) and
 * live ticks are served from the histogram in O(buckets). The final result is
 * still EXACT nearest-rank percentiles, computed by sorting once at settle time,
 * so reported numbers stay identical to the previous implementation.
 */
export class LatencyRecorder {
  private samples: Float64Array;
  private length = 0;
  private readonly counts: number[];
  private sumMs = 0;
  private lowest = 0;
  private highest = 0;

  constructor(
    private readonly boundsMs: readonly number[],
    initialCapacity = 4096,
  ) {
    if (boundsMs.length === 0) throw new Error('Latency bounds required');
    if (!Number.isInteger(initialCapacity) || initialCapacity < 1)
      throw new Error('Invalid latency capacity');
    this.samples = new Float64Array(initialCapacity);
    this.counts = Array.from({ length: boundsMs.length + 1 }, () => 0);
  }

  get count(): number {
    return this.length;
  }

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid latency sample');
    if (this.length === this.samples.length) {
      const grown = new Float64Array(this.samples.length * 2);
      grown.set(this.samples);
      this.samples = grown;
    }
    if (this.length === 0) {
      this.lowest = value;
      this.highest = value;
    } else {
      if (value < this.lowest) this.lowest = value;
      if (value > this.highest) this.highest = value;
    }
    this.samples[this.length++] = value;
    this.sumMs += value;
    const index = this.boundsMs.findIndex((bound) => value <= bound);
    this.counts[index < 0 ? this.boundsMs.length : index]++;
  }

  /** Non-cumulative bucket counts, identical to {@link latencyHistogram}. */
  histogram(): LatencyHistogram {
    return {
      boundsMs: [...this.boundsMs],
      counts: [...this.counts],
      count: this.length,
      sumMs: this.sumMs,
    };
  }

  /**
   * Cumulative upper-bound percentile straight from the buckets: no sort, no
   * allocation. This is the same conservative policy the fleet reports
   * ('histogram-upper-bound-v1'), so a live tick never under-states a tail.
   */
  livePercentile(percent: number): number {
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
      throw new Error('Invalid percentile');
    if (this.length === 0) return 0;
    const rank = Math.ceil((this.length * percent) / 100);
    let seen = 0;
    for (let bucket = 0; bucket < this.counts.length; bucket++) {
      seen += this.counts[bucket];
      if (seen >= rank) return Number((this.boundsMs[bucket] ?? this.highest).toFixed(2));
    }
    return Number(this.highest.toFixed(2));
  }

  /** Exact nearest-rank summary; sorts one copy, intended for settle time only. */
  finalize(): { min: number; max: number; mean: number; p50: number; p95: number; p99: number } {
    if (this.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    const sorted = this.samples.slice(0, this.length).sort();
    return {
      min: sorted[0],
      max: sorted[this.length - 1],
      mean: Number((this.sumMs / this.length).toFixed(2)),
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }
}
