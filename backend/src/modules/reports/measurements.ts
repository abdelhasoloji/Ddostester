import type { CampaignRun } from '../campaigns/runner.js';

/** Presentation projections never replace absent observations with a success or zero. */
export function observedAvailability(run: CampaignRun): number | null {
  const { samples, available } = run.probe;
  return Number.isSafeInteger(samples) &&
    samples > 0 &&
    Number.isSafeInteger(available) &&
    available >= 0 &&
    available <= samples
    ? (available / samples) * 100
    : null;
}

export function observedProbeP95(run: CampaignRun): number | null {
  const value = run.probe.latencyMs?.p95;
  return observedAvailability(run) !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

export function baselineComparisonAvailable(run: CampaignRun): boolean {
  const baseline = run.baseline;
  const delta = run.baselineDelta;
  return (
    (run.probe.endpoints?.length ?? 1) <= 1 &&
    observedProbeP95(run) !== null &&
    !!baseline &&
    Number.isSafeInteger(baseline.samples) &&
    baseline.samples > 0 &&
    baseline.observation?.complete !== false &&
    baseline.stable !== false &&
    !!delta &&
    [
      baseline.latencyMs.p50,
      baseline.latencyMs.p95,
      delta.latencyP50DeltaMs,
      delta.latencyP95DeltaMs,
      delta.availabilityDeltaPct,
    ].every(Number.isFinite)
  );
}
