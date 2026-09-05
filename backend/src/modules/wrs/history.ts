import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import type { WrsBreakdown } from './scoring.js';

export interface WrsPoint {
  at: string;
  wrs: number;
  level: WrsBreakdown['level'];
  runId: string;
}

export interface WrsSeries {
  target: string;
  points: WrsPoint[];
  /** Regression if WRS dropped by more than 10 points vs the previous run (WRS-03). */
  regression: boolean;
  drop: number;
}

const REGRESSION_THRESHOLD = 10;

/** Builds the per-target WRS history (old → recent) + regression detection. */
export function buildWrsHistory(campaigns: Campaign[], runs: CampaignRun[]): WrsSeries[] {
  const targetOf = new Map(campaigns.map((c) => [c.id, c.target]));
  const byTarget = new Map<string, WrsPoint[]>();

  for (const r of runs) {
    let host = targetOf.get(r.campaignId) ?? '—';
    try {
      host = new URL(host).hostname;
    } catch {
      /* keep raw */
    }
    const arr = byTarget.get(host) ?? [];
    arr.push({ at: r.generator.finishedAt, wrs: r.wrs.wrs, level: r.wrs.level, runId: r.runId });
    byTarget.set(host, arr);
  }

  const series: WrsSeries[] = [];
  for (const [target, points] of byTarget) {
    points.sort((a, b) => a.at.localeCompare(b.at));
    let drop = 0;
    if (points.length >= 2) {
      const prev = points[points.length - 2].wrs;
      const last = points[points.length - 1].wrs;
      drop = Math.max(0, prev - last);
    }
    series.push({ target, points, regression: drop > REGRESSION_THRESHOLD, drop });
  }
  series.sort((a, b) => a.target.localeCompare(b.target));
  return series;
}
