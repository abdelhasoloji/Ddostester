import { percentile } from '../../engine/stats.js';

/**
 * Automatic baseline (EPIC B2). Before the ramp, the runner captures a short
 * window of the target under **legitimate traffic only** (a few probe GETs) to
 * record nominal availability and latency. The run then reports the deltas
 * (degradation under load vs. nominal) so a result is interpretable on its own.
 * Bounded, legitimate measurement — it generates no attack load.
 */

export interface BaselineMetrics {
  /** Number of pre-load probe samples taken. */
  samples: number;
  /** Nominal availability (%) with no generated load. */
  availabilityPct: number;
  /** Nominal probe latency (ms). */
  latencyMs: { p50: number; p95: number };
}

export interface BaselineDelta {
  /** Under-load minus baseline; positive = latency got worse. */
  latencyP50DeltaMs: number;
  latencyP95DeltaMs: number;
  /** Under-load minus baseline; negative = availability dropped. */
  availabilityDeltaPct: number;
}

/** Under-load view compared against the baseline. */
export interface UnderLoad {
  availabilityPct: number;
  latencyMs: { p50: number; p95: number };
}

/** Injectable baseline capture (stubbed in tests). */
export type CaptureBaseline = (url: string, signal?: AbortSignal) => Promise<BaselineMetrics>;

/**
 * Bounded pre-load probe: `count` legitimate GETs, `intervalMs` apart, recording
 * availability and latency. Never throws — an unavailable target yields 0%.
 */
export async function captureBaseline(
  url: string,
  signal?: AbortSignal,
  count = 3,
  intervalMs = 1000,
  timeoutMs = 5000,
): Promise<BaselineMetrics> {
  const lat: number[] = [];
  let ok = 0;
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) break;
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (res.ok) ok++;
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      /* target unavailable → counts against availability */
    } finally {
      clearTimeout(timer);
    }
    lat.push(performance.now() - t0);
    if (i < count - 1 && !signal?.aborted) await new Promise((r) => setTimeout(r, intervalMs));
  }
  const n = lat.length || 1;
  const sorted = [...lat].sort((a, b) => a - b);
  return {
    samples: lat.length,
    availabilityPct: Number(((ok / n) * 100).toFixed(1)),
    latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95) },
  };
}

/** Pure delta of the under-load metrics against the baseline. */
export function computeBaselineDelta(
  baseline: BaselineMetrics,
  underLoad: UnderLoad,
): BaselineDelta {
  return {
    latencyP50DeltaMs: Number((underLoad.latencyMs.p50 - baseline.latencyMs.p50).toFixed(2)),
    latencyP95DeltaMs: Number((underLoad.latencyMs.p95 - baseline.latencyMs.p95).toFixed(2)),
    availabilityDeltaPct: Number((underLoad.availabilityPct - baseline.availabilityPct).toFixed(1)),
  };
}
