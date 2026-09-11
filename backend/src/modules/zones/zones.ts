import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { buildWrsHistory } from '../wrs/history.js';
import { buildAbsorptionSummary } from '../observability/summary.js';

/**
 * Protected ZONES — the WEDOS-Protection framing on top of the existing model.
 *
 * A "zone" is a protected customer/host: the unit WEDOS Protection is sold and
 * measured by. This is a DERIVED grouping of the existing campaigns by target
 * host — no new storage, no migration. Each zone's posture reuses the per-target
 * pipelines already in place (WRS history + absorption rollup), so assurance
 * becomes per-customer instead of per-campaign. See docs/vision-proving-ground.md.
 */
export interface ZoneSummary {
  /** The protected host — the zone key (e.g. "bank.cz"). */
  host: string;
  campaigns: number;
  suites: number;
  /** A run is in flight against this zone right now. */
  running: boolean;
  /** Latest / mean WRS across the zone's runs, and whether it regressed. */
  lastWrs?: number;
  lastLevel?: string;
  meanWrs?: number;
  regression: boolean;
  /** Latest edge-absorption % (how much the WEDOS edge absorbed). */
  lastAbsorbedPct?: number;
  /** Highest DRS tier exercised against the zone (parsed from campaign names). */
  maxDrs?: number;
  /** Most recent test time (ISO), newest run/campaign in the zone. */
  lastTestAt?: string;
}

/** Normalise a target (URL or bare host) to its host — the zone key. */
export function zoneHost(target: string): string {
  if (!target) return '';
  try {
    return new URL(target).host || target;
  } catch {
    return target.replace(/^https?:\/\//, '').split('/')[0];
  }
}

const RUNNING = new Set(['RUNNING']);
const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Group the campaign estate into protected zones (newest activity first),
 * each carrying its assurance posture. Pure: derives everything from the
 * campaigns + runs already in the store.
 */
export function buildZones(campaigns: Campaign[], runs: CampaignRun[]): ZoneSummary[] {
  const wrsByHost = new Map<string, ReturnType<typeof buildWrsHistory>[number]>();
  for (const s of buildWrsHistory(campaigns, runs)) {
    // If several targets share a host, keep the one with the most points.
    const h = zoneHost(s.target);
    const prev = wrsByHost.get(h);
    if (!prev || s.points.length > prev.points.length) wrsByHost.set(h, s);
  }
  const absByHost = new Map<string, { pct: number[]; last: number }>();
  for (const row of buildAbsorptionSummary(runs, campaigns)) {
    const h = zoneHost(row.target);
    const e = absByHost.get(h) ?? { pct: [], last: row.lastAbsorbedPct };
    e.pct.push(row.lastAbsorbedPct);
    e.last = row.lastAbsorbedPct;
    absByHost.set(h, e);
  }

  const byHost = new Map<string, Campaign[]>();
  for (const c of campaigns) {
    const h = zoneHost(c.target);
    (byHost.get(h) ?? byHost.set(h, []).get(h)!).push(c);
  }

  const zones: ZoneSummary[] = [];
  for (const [host, cs] of byHost) {
    const suites = new Set(cs.map((c) => c.suiteId).filter(Boolean)).size;
    const running = cs.some((c) => RUNNING.has(c.status));
    const wrs = wrsByHost.get(host);
    const last = wrs?.points[wrs.points.length - 1];
    const meanWrs = wrs?.points.length
      ? Math.round(wrs.points.reduce((s, p) => s + p.wrs, 0) / wrs.points.length)
      : undefined;
    const abs = absByHost.get(host);
    let maxDrs: number | undefined;
    for (const c of cs) {
      const m = c.name.match(/DRS\s*([1-7])/i);
      if (m) maxDrs = Math.max(maxDrs ?? 0, Number(m[1]));
    }
    const times = cs
      .map((c) => c.finishedAt ?? c.startedAt ?? c.createdAt)
      .filter((t): t is string => Boolean(t))
      .sort();
    zones.push({
      host,
      campaigns: cs.length,
      suites,
      running,
      lastWrs: last?.wrs,
      lastLevel: last?.level,
      meanWrs,
      regression: wrs?.regression ?? false,
      lastAbsorbedPct: abs ? round1(abs.last) : undefined,
      maxDrs,
      lastTestAt: times[times.length - 1],
    });
  }

  // Most recently active zones first; then by name for stability.
  return zones.sort(
    (a, b) =>
      (b.lastTestAt ?? '').localeCompare(a.lastTestAt ?? '') || a.host.localeCompare(b.host),
  );
}
