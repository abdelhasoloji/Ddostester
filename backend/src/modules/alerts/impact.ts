/**
 * Impact leaderboard (E16): from run history, the steps that actually FLOORED
 * the target — ranked by how hard they hit it. Deliberately EXCLUDES the
 * probe-contention false negatives (PF1): a run where the probe lost the race to
 * the flood but the target was serving is NOT an impact, and must not appear here
 * as if the step took the target down. Pure + testable.
 */
import type { CampaignRun } from '../campaigns/runner.js';
import type { Campaign } from '../campaigns/model.js';

export interface ImpactEntry {
  runId: string;
  campaignId: string;
  name: string;
  target?: string;
  engine?: string;
  at?: string;
  /** Availability the target held during the run (%), truthful (not contended). */
  availabilityPct: number;
  /** Offered rps at which it broke, when a breaking point was reached. */
  breakingRps?: number;
  /** Highest rps it sustained cleanly (context for the breaking point). */
  sustainedRps?: number;
  /** Was the run auto-killed for a REAL outage (not probe contention)? */
  autoKilled: boolean;
  wrs: number;
  /** Composite severity used for ranking (higher = hit the target harder). */
  severity: number;
}

function availabilityOf(run: CampaignRun): number {
  const s = run.probe?.samples ?? 0;
  return s > 0 ? Math.round((run.probe.available / s) * 100) : 100;
}

/**
 * Returns the runs that genuinely degraded the target, most-impactful first.
 * A run counts when a breaking point was reached, OR the probe measured a real
 * availability drop (<80%) that is NOT explained by probe contention, OR it was
 * auto-killed for a real outage (not contention).
 */
export function deriveImpact(
  runs: CampaignRun[],
  campaigns: Campaign[],
  opts: { limit?: number; availFloor?: number } = {},
): ImpactEntry[] {
  const limit = opts.limit ?? 20;
  const availFloor = opts.availFloor ?? 80;
  const nameOf = new Map(campaigns.map((c) => [c.id, c.name] as const));
  const targetOf = new Map(campaigns.map((c) => [c.id, c.target] as const));

  const entries: ImpactEntry[] = [];
  for (const run of runs) {
    const contended = run.probeContended === true;
    const availabilityPct = contended ? 100 : availabilityOf(run);
    const brokeByBP = run.breakingPoint?.reached === true;
    const brokeByAvail = !contended && availabilityPct < availFloor;
    const realAutoKill = run.status === 'KILLED_AUTO' && !contended;
    if (!brokeByBP && !brokeByAvail && !realAutoKill) continue;

    // Severity: how hard it hit. A big availability drop dominates; a breaking
    // point that came EARLY (low rps) means the target was weak → more impact.
    const bpBonus = brokeByBP ? 25 + Math.max(0, 30 - (run.breakingPoint?.rps ?? 0) / 20) : 0;
    const severity = 100 - availabilityPct + (realAutoKill ? 20 : 0) + bpBonus;

    entries.push({
      runId: run.runId,
      campaignId: run.campaignId,
      name: nameOf.get(run.campaignId) ?? run.campaignId,
      target: targetOf.get(run.campaignId),
      engine: run.engine,
      at: run.generator?.finishedAt,
      availabilityPct,
      breakingRps: brokeByBP ? run.breakingPoint?.rps : undefined,
      sustainedRps: run.breakingPoint?.sustainedRps,
      autoKilled: realAutoKill,
      wrs: run.wrs?.wrs ?? 0,
      severity: Math.round(severity),
    });
  }
  entries.sort((a, b) => b.severity - a.severity);
  return entries.slice(0, limit);
}
