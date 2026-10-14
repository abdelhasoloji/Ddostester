import { captureBaseline, type BaselineMetrics } from '../campaigns/baseline.js';
import { DRS_EVIDENCE_LIMITS, type RemoteProbeConfig } from '../../config/limits.js';
import type { DrsPlan } from './model.js';
import { ensure } from './model.js';
/** Independent low-rate HTTP health reference. No generator or functional-journey claim. */
export async function captureDrsBaseline(
  url: string,
  plan: DrsPlan,
  parent: AbortSignal,
  remote?: RemoteProbeConfig,
  capture = captureBaseline,
): Promise<BaselineMetrics> {
  const signal = AbortSignal.any([
    parent,
    AbortSignal.timeout(DRS_EVIDENCE_LIMITS.baselineMaxSec * 1000),
  ]);
  const began = performance.now();
  let result = await capture(
    url,
    signal,
    Math.ceil(plan.baselineMinSec) + 1,
    1000,
    5000,
    remote,
    true,
  );
  const stable = (r: BaselineMetrics) => {
    const a = r.samplesMs ?? [];
    if (!a.length) return false;
    const mean = a.reduce((s, x) => s + x, 0) / a.length;
    const cv = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length) / (mean || 1);
    return cv <= plan.baselineStabilityTolerance;
  };
  ensure(result.availabilityPct === 100, 'DRS baseline target is unhealthy; no injection');
  if (!stable(result) && !signal.aborted) {
    const remaining = Math.floor(
      DRS_EVIDENCE_LIMITS.baselineMaxSec - (performance.now() - began) / 1000,
    );
    if (remaining > 0) {
      const extra = await capture(
        url,
        signal,
        Math.min(remaining, Math.ceil(plan.baselineMinSec)),
        1000,
        5000,
        remote,
        true,
      );
      result = {
        ...result,
        samples: result.samples + extra.samples,
        samplesMs: [...(result.samplesMs ?? []), ...(extra.samplesMs ?? [])],
        availabilityPct: Math.min(result.availabilityPct, extra.availabilityPct),
        durationSec: (result.durationSec ?? 0) + (extra.durationSec ?? 0),
      };
    }
  }
  ensure(
    !signal.aborted &&
      result.availabilityPct === 100 &&
      (result.durationSec ?? 0) >= plan.baselineMinSec &&
      stable(result),
    'DRS baseline remains unstable, incomplete or cancelled; no injection',
  );
  return { ...result, stable: true, functionalAssertionMeasured: false };
}
