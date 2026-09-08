import type { CampaignRun } from '../modules/campaigns/runner.js';

/** Probe availability (%) measured during the run; 100 when no probe samples.
 * Single source of truth shared by the report and remediation modules (kept
 * dependency-free to avoid an import cycle between them). */
export function availabilityPct(run: CampaignRun): number {
  return run.probe.samples ? (run.probe.available / run.probe.samples) * 100 : 100;
}
