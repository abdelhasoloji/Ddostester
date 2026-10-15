import { captureBaseline, type BaselineMetrics } from '../campaigns/baseline.js';
import { DRS_EVIDENCE_LIMITS, type RemoteProbeConfig } from '../../config/limits.js';
import type { DrsPlan } from './model.js';
import { DrsError } from './model.js';

export interface DrsBaselineDiagnostic {
  reason: 'unhealthy' | 'unstable' | 'incomplete' | 'cancelled' | 'deadline';
  elapsedSec: number;
  observedDurationSec: number;
  samples: number;
  samplesMs: number[];
  availabilityPct: number;
  meanMs: number | null;
  coefficientOfVariation: number | null;
  tolerance: number;
  minimumSec: number;
}
export class DrsBaselineError extends DrsError {
  constructor(readonly diagnostic: DrsBaselineDiagnostic) {
    super(
      `DRS baseline ${diagnostic.reason}; ${diagnostic.samples} samples, ${diagnostic.observedDurationSec.toFixed(1)}s, CV ${diagnostic.coefficientOfVariation?.toFixed(4) ?? 'unknown'} / ${diagnostic.tolerance}; no injection`,
    );
  }
}

/** Independent low-rate HTTP health reference. No functional-journey claim. */
export async function captureDrsBaseline(
  url: string,
  plan: DrsPlan,
  parent: AbortSignal,
  remote?: RemoteProbeConfig,
  capture = captureBaseline,
): Promise<BaselineMetrics> {
  const timeout = AbortSignal.timeout(DRS_EVIDENCE_LIMITS.baselineMaxSec * 1000);
  const signal = AbortSignal.any([parent, timeout]);
  const began = performance.now();
  const interval = DRS_EVIDENCE_LIMITS.baselineIntervalMs;
  const requestTimeout = DRS_EVIDENCE_LIMITS.baselineRequestTimeoutMs;
  const sample = (count: number, waitBefore = false) =>
    capture(url, signal, count, interval, requestTimeout, remote, true, true, waitBefore);
  let result = await sample(Math.ceil((plan.baselineMinSec * 1000) / interval) + 1);
  const diagnostic = (reason: DrsBaselineDiagnostic['reason']): DrsBaselineDiagnostic => {
    const samplesMs = (result.samplesMs ?? []).slice(0, DRS_EVIDENCE_LIMITS.maxSamples);
    const meanMs = samplesMs.length
      ? samplesMs.reduce((s, x) => s + x, 0) / samplesMs.length
      : null;
    return {
      reason,
      elapsedSec: (performance.now() - began) / 1000,
      observedDurationSec: result.durationSec ?? 0,
      samples: result.samples,
      samplesMs,
      availabilityPct: result.availabilityPct,
      meanMs,
      coefficientOfVariation:
        meanMs === null
          ? null
          : Math.sqrt(samplesMs.reduce((s, x) => s + (x - meanMs) ** 2, 0) / samplesMs.length) /
            (meanMs || 1),
      tolerance: plan.baselineStabilityTolerance,
      minimumSec: plan.baselineMinSec,
    };
  };
  const stable = () => {
    const cv = diagnostic('unstable').coefficientOfVariation;
    return cv !== null && cv <= plan.baselineStabilityTolerance;
  };
  // Check convergence in small bounded batches. Reserve one complete request timeout;
  // do not schedule a batch that can only end after the absolute observation deadline.
  while (!signal.aborted && result.availabilityPct === 100 && !stable()) {
    const remainingMs = DRS_EVIDENCE_LIMITS.baselineMaxSec * 1000 - (performance.now() - began);
    const count = Math.min(
      DRS_EVIDENCE_LIMITS.baselineExtensionSamples,
      Math.floor((remainingMs - requestTimeout) / Math.max(interval, requestTimeout)),
      DRS_EVIDENCE_LIMITS.maxSamples - result.samples,
    );
    if (count < 1) break;
    const extra = await sample(count, true);
    result = {
      ...result,
      samples: result.samples + extra.samples,
      samplesMs: [...(result.samplesMs ?? []), ...(extra.samplesMs ?? [])],
      availabilityPct: Math.min(result.availabilityPct, extra.availabilityPct),
      durationSec: (performance.now() - began) / 1000,
    };
    // A broken/empty collector must not spin while pretending observation progressed.
    if (!extra.samples || (extra.durationSec ?? 0) <= 0) break;
  }
  const reason = parent.aborted
    ? 'cancelled'
    : timeout.aborted
      ? 'deadline'
      : result.availabilityPct !== 100
        ? 'unhealthy'
        : (result.durationSec ?? 0) < plan.baselineMinSec || !result.samplesMs?.length
          ? 'incomplete'
          : !stable()
            ? 'unstable'
            : null;
  if (reason) throw new DrsBaselineError(diagnostic(reason));
  return { ...result, stable: true, functionalAssertionMeasured: false };
}
