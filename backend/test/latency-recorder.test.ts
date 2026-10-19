import { describe, expect, it } from 'vitest';
import { LATENCY_BUCKETS_MS } from '../src/config/limits.js';
import { LatencyRecorder, latencyHistogram, percentile } from '../src/engine/stats.js';

const SAMPLES = [3.2, 1.1, 40, 2.5, 999, 12, 7.75, 0.4, 250, 60];

describe('LatencyRecorder', () => {
  it('builds exactly the batch histogram', () => {
    const recorder = new LatencyRecorder(LATENCY_BUCKETS_MS);
    for (const sample of SAMPLES) recorder.observe(sample);
    expect(recorder.histogram()).toEqual(latencyHistogram(SAMPLES, LATENCY_BUCKETS_MS));
  });

  it('reports the same exact percentiles as sorting every sample', () => {
    const recorder = new LatencyRecorder(LATENCY_BUCKETS_MS);
    for (const sample of SAMPLES) recorder.observe(sample);
    const sorted = [...SAMPLES].sort((a, b) => a - b);
    const mean = SAMPLES.reduce((sum, value) => sum + value, 0) / SAMPLES.length;
    expect(recorder.finalize()).toEqual({
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: Number(mean.toFixed(2)),
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    });
  });

  it('grows past its initial capacity without losing a sample', () => {
    const recorder = new LatencyRecorder(LATENCY_BUCKETS_MS, 1);
    for (let value = 1; value <= 5000; value++) recorder.observe(value);
    expect(recorder.count).toBe(5000);
    expect(recorder.finalize()).toMatchObject({ min: 1, max: 5000, p50: 2500 });
  });

  it('bounds a live percentile by its bucket and never under-states the exact value', () => {
    const recorder = new LatencyRecorder(LATENCY_BUCKETS_MS);
    for (const sample of SAMPLES) recorder.observe(sample);
    const exact = recorder.finalize().p50;
    const live = recorder.livePercentile(50);
    expect(live).toBeGreaterThanOrEqual(exact);
    expect(live).toBe(10); // first bound >= the 5th of 10 sorted samples (7.75)
  });

  it('handles an empty recorder', () => {
    const recorder = new LatencyRecorder(LATENCY_BUCKETS_MS);
    expect(recorder.count).toBe(0);
    expect(recorder.livePercentile(95)).toBe(0);
    expect(recorder.finalize()).toEqual({ min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 });
  });

  it('rejects invalid samples and percentiles', () => {
    const recorder = new LatencyRecorder(LATENCY_BUCKETS_MS);
    expect(() => recorder.observe(-1)).toThrow('Invalid latency sample');
    expect(() => recorder.observe(Number.NaN)).toThrow('Invalid latency sample');
    recorder.observe(5);
    expect(() => recorder.livePercentile(0)).toThrow('Invalid percentile');
    expect(() => recorder.livePercentile(101)).toThrow('Invalid percentile');
  });
});
