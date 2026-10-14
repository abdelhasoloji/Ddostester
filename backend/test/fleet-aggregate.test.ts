import { describe, expect, it } from 'vitest';
import { latencyHistogram } from '../src/engine/stats.js';
import { LATENCY_BUCKETS_MS } from '../src/config/limits.js';
import { mergeHistograms, percentileUpperBound } from '../src/modules/fleet/aggregate.js';
describe('fleet histogram aggregation', () => {
  it('weights all observations, not an average of agent percentiles', () => {
    const fast = latencyHistogram(
      Array.from({ length: 100 }, () => 10),
      LATENCY_BUCKETS_MS,
    );
    const slow = latencyHistogram([1000], LATENCY_BUCKETS_MS);
    const merged = mergeHistograms([fast, slow]);
    expect(merged.count).toBe(101);
    expect(merged.sumMs).toBe(2000);
    expect(percentileUpperBound(merged, 95)).toBe(10);
  });
  it('keeps missing observations and overflow explicit', () => {
    expect(percentileUpperBound(mergeHistograms([]), 95)).toBeNull();
    expect(percentileUpperBound(latencyHistogram([70000], LATENCY_BUCKETS_MS), 95)).toBeNull();
  });
  it('refuses incompatible buckets and inconsistent counts', () => {
    const h = latencyHistogram([10], LATENCY_BUCKETS_MS);
    expect(() => mergeHistograms([{ ...h, boundsMs: [10] }])).toThrow();
    expect(() => mergeHistograms([{ ...h, count: 2 }])).toThrow();
  });
});
