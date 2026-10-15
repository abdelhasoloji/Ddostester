import {
  summarizeProbeQuality,
  type ProbeQuality,
  type ProbeQualitySummary,
} from '../probe/quality.js';
import { remoteProbeQualityReasons } from '../reports/confidence.js';
import { sampleRemoteProbe } from '../probe/remote.js';
import type { RemoteProbeConfig } from '../../config/limits.js';
import { readBoundedBody } from '../../util/http-body.js';
import { IO_LIMITS } from '../../config/limits.js';
import { percentile } from '../../engine/stats.js';

/**
 * Automatic baseline (EPIC B2). Before the ramp, the runner captures a short
 * window of the target under **legitimate traffic only** (a few probe GETs) to
 * record nominal availability and latency. The run then reports the deltas
 * (degradation under load vs. nominal) so a result is interpretable on its own.
 * Bounded, legitimate measurement — it generates no attack load.
 */

export interface BaselineMetrics {
  durationSec?: number;
  samplesMs?: number[];
  stable?: boolean;
  functionalAssertionMeasured?: boolean;
  quality?: ProbeQualitySummary;
  observation?: {
    vantage: 'remote';
    expectedSamples: number;
    receivedSamples: number;
    missingSamples: number;
    complete: boolean;
  };
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
  remote?: RemoteProbeConfig,
  retainSamples = false,
  fixedCadence = false,
): Promise<BaselineMetrics> {
  const began = performance.now();
  const lat: number[] = [];
  let ok = 0;
  let received = 0;
  const diagnostics: ProbeQuality[] = [];
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) break;
    const t0 = performance.now();
    const ac = new AbortController();
    const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let ttfbMs = 0;
    try {
      if (remote) {
        const sample = await sampleRemoteProbe(remote, url, timeoutMs, combined);
        received++;
        if (sample.quality) diagnostics.push(sample.quality);
        ttfbMs = sample.latencyMs;
        if (sample.ok) ok++;
      } else {
        const res = await fetch(url, { signal: combined, redirect: 'manual' });
        // TTFB (time to response headers), measured BEFORE draining the body —
        // consistent with the live Probe, so the under-load-vs-baseline latency
        // delta compares like with like and isn't skewed by response size.
        ttfbMs = performance.now() - t0;
        if (res.ok) ok++;
        await readBoundedBody(res.body, IO_LIMITS.responseBytes, false);
      }
    } catch {
      /* Missing remote observation is not an attributed target outage. */
      ttfbMs = performance.now() - t0; // time to failure
    } finally {
      clearTimeout(timer);
    }
    lat.push(ttfbMs);
    if (i < count - 1 && !signal?.aborted) {
      const delay = fixedCadence ? Math.max(0, t0 + intervalMs - performance.now()) : intervalMs;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
  }
  const n = lat.length || 1;
  const sorted = [...lat].sort((a, b) => a - b);
  return {
    ...(retainSamples
      ? {
          durationSec: (performance.now() - began) / 1000,
          samplesMs: lat,
          functionalAssertionMeasured: false,
        }
      : {}),
    ...(remote
      ? {
          observation: {
            vantage: 'remote' as const,
            expectedSamples: count,
            receivedSamples: received,
            missingSamples: Math.max(0, count - received),
            complete: count > 0 && received === count && lat.length === count,
          },
        }
      : {}),
    ...(remote ? { quality: summarizeProbeQuality(diagnostics, lat.length) } : {}),
    samples: lat.length,
    availabilityPct: Number(((ok / n) * 100).toFixed(1)),
    latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95) },
  };
}

/** Pure delta of the under-load metrics against the baseline. */
export function computeBaselineDelta(
  baseline: BaselineMetrics,
  underLoad: UnderLoad,
): BaselineDelta | undefined {
  if (
    baseline.samples === 0 ||
    baseline.observation?.complete === false ||
    (baseline.quality && remoteProbeQualityReasons(baseline.quality).length)
  )
    return undefined;
  return {
    latencyP50DeltaMs: Number((underLoad.latencyMs.p50 - baseline.latencyMs.p50).toFixed(2)),
    latencyP95DeltaMs: Number((underLoad.latencyMs.p95 - baseline.latencyMs.p95).toFixed(2)),
    availabilityDeltaPct: Number((underLoad.availabilityPct - baseline.availabilityPct).toFixed(1)),
  };
}
