/**
 * In-app alerts — derived from the platform's OWN run history (self-contained,
 * no dependency on Prometheus/Alertmanager reachability). Surfaces the same
 * signals the Alertmanager rules watch, but computed from the store so the app
 * is a single pane of glass even when the monitoring stack is unreachable.
 */
import type { CampaignRun } from '../campaigns/runner.js';
import type { Campaign } from '../campaigns/model.js';

export interface Alert {
  severity: 'critical' | 'warning' | 'info';
  /** Stable-ish key for de-dup / React keys: `${runId}:${kind}`. */
  key: string;
  kind:
    | 'tarpit'
    | 'low-wrs'
    | 'degraded'
    | 'auto-killed'
    | 'not-engaging'
    | 'wrs-regression'
    | 'protection-regression';
  title: string;
  detail: string;
  campaignId?: string;
  runId: string;
  target?: string;
  at?: string; // ISO (generator.finishedAt when available)
  // Investigation context (E10): each alert is a self-contained starting point.
  /** The load engine that actually ran (post auto-route), when recorded. */
  engine?: string;
  /** Run wall-clock in seconds, from the generator's own timestamps. */
  durationSec?: number;
  /** The single metric that triggered this alert, structured for display. */
  metric?: { label: string; value: string };
}

/** Run wall-clock (s) from the generator's own start/finish timestamps. */
function runDurationSec(run: CampaignRun): number | undefined {
  const s = run.generator?.startedAt ? Date.parse(run.generator.startedAt) : NaN;
  const f = run.generator?.finishedAt ? Date.parse(run.generator.finishedAt) : NaN;
  if (Number.isNaN(s) || Number.isNaN(f) || f < s) return undefined;
  return Math.round((f - s) / 1000);
}

/** WRS at/below this is flagged (mirrors the Alertmanager WRSDrop rule). */
export const LOW_WRS_THRESHOLD = 70;

/** Regression detection (E1) — relative to a target's own history, not a static
 *  threshold. A target that used to absorb 80% of a shape but now absorbs 30% is
 *  a protection regression even if its WRS is still fine. */
export const MIN_BASELINE_RUNS = 4;
export const WRS_REGRESSION_DROP = 12; // WRS points below the target's baseline mean
export const ABSORB_REGRESSION_FACTOR = 0.5; // absorbed < 50% of its baseline mean
const ABSORB_BASELINE_FLOOR = 0.2; // only meaningful if the target normally absorbs ≥20%

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Flags the most-recent run per target when its WRS or protection absorption has
 * regressed against that target's own recent baseline. Inert until a target has
 * accumulated MIN_BASELINE_RUNS runs.
 */
export function deriveRegressions(runs: CampaignRun[], campaigns: Campaign[]): Alert[] {
  const nameOf = new Map(campaigns.map((c) => [c.id, c.name] as const));
  const targetOf = new Map(campaigns.map((c) => [c.id, c.target] as const));
  // Group runs by resolved target, chronological.
  const byTarget = new Map<string, CampaignRun[]>();
  for (const r of runs) {
    const t = targetOf.get(r.campaignId);
    if (!t) continue;
    (byTarget.get(t) ?? byTarget.set(t, []).get(t)!).push(r);
  }
  const absorbedOf = (r: CampaignRun): number =>
    r.absorption?.absorbedRatio ??
    (r.generator?.totalRequests ? r.generator.failed / r.generator.totalRequests : 0);

  const alerts: Alert[] = [];
  for (const [target, group] of byTarget) {
    if (group.length < MIN_BASELINE_RUNS) continue;
    const chron = [...group].sort((a, b) =>
      (a.generator?.finishedAt ?? '').localeCompare(b.generator?.finishedAt ?? ''),
    );
    const latest = chron[chron.length - 1];
    const prior = chron.slice(0, -1);
    const label = nameOf.get(latest.campaignId) ?? target;
    const base = {
      campaignId: latest.campaignId,
      runId: latest.runId,
      target,
      at: latest.generator?.finishedAt,
      engine: latest.engine,
      durationSec: runDurationSec(latest),
    };

    const wrsBaseline = mean(prior.map((r) => r.wrs?.wrs ?? 0));
    if (
      typeof latest.wrs?.wrs === 'number' &&
      wrsBaseline - latest.wrs.wrs >= WRS_REGRESSION_DROP
    ) {
      alerts.push({
        ...base,
        severity: 'warning',
        kind: 'wrs-regression',
        key: `${latest.runId}:wrs-regression`,
        title: `WRS regression — ${label}`,
        detail: `WRS ${latest.wrs.wrs} is ${Math.round(wrsBaseline - latest.wrs.wrs)} pts below this target's recent baseline (~${Math.round(wrsBaseline)} over ${prior.length} runs). Protection may be degrading.`,
        metric: { label: 'WRS drop', value: `${Math.round(wrsBaseline - latest.wrs.wrs)} pts` },
      });
    }

    const absBaseline = mean(prior.map(absorbedOf));
    const absLatest = absorbedOf(latest);
    if (
      absBaseline >= ABSORB_BASELINE_FLOOR &&
      absLatest < absBaseline * ABSORB_REGRESSION_FACTOR
    ) {
      alerts.push({
        ...base,
        severity: 'warning',
        kind: 'protection-regression',
        key: `${latest.runId}:protection-regression`,
        title: `Protection stopped engaging — ${label}`,
        detail: `The edge absorbed ${Math.round(absLatest * 100)}% this run vs ~${Math.round(absBaseline * 100)}% baseline (${prior.length} runs). It used to bite this shape and now largely lets it through.`,
        metric: {
          label: 'Absorbed',
          value: `${Math.round(absLatest * 100)}% (was ${Math.round(absBaseline * 100)}%)`,
        },
      });
    }
  }
  return alerts;
}

export interface DeriveOptions {
  /** Only consider the most recent N runs (by finishedAt). Default 30. */
  recent?: number;
  /** Cap the number of alerts returned. Default 50. */
  limit?: number;
}

export function deriveAlerts(
  runs: CampaignRun[],
  campaigns: Campaign[],
  opts: DeriveOptions = {},
): Alert[] {
  const recent = opts.recent ?? 30;
  const limit = opts.limit ?? 50;
  const nameOf = new Map(campaigns.map((c) => [c.id, c.name] as const));
  const targetOf = new Map(campaigns.map((c) => [c.id, c.target] as const));

  const sorted = [...runs].sort((a, b) =>
    (b.generator?.finishedAt ?? '').localeCompare(a.generator?.finishedAt ?? ''),
  );

  // Regression alerts (relative to each target's own history) lead — they are the
  // most actionable signal. Then the per-run alerts.
  const alerts: Alert[] = deriveRegressions(runs, campaigns);
  for (const run of sorted.slice(0, recent)) {
    const label = nameOf.get(run.campaignId) ?? run.campaignId;
    const target = targetOf.get(run.campaignId);
    const at = run.generator?.finishedAt;
    const base = {
      campaignId: run.campaignId,
      runId: run.runId,
      target,
      at,
      engine: run.engine,
      durationSec: runDurationSec(run),
    };
    const availPct =
      run.probe?.windowAvailPct ??
      (run.probe?.samples
        ? Math.round((run.probe.available / run.probe.samples) * 100)
        : undefined);

    if (run.generator?.hardStopped) {
      alerts.push({
        ...base,
        severity: 'warning',
        kind: 'tarpit',
        key: `${run.runId}:tarpit`,
        title: `Target tarpitting — ${label}`,
        detail:
          'A run was force-settled by the hard backstop (the edge held connections past the cap). Protection is biting; achieved load may be understated.',
        metric:
          run.absorption?.absorbedPct != null
            ? { label: 'Absorbed', value: `${Math.round(run.absorption.absorbedPct)}%` }
            : { label: 'Hard-stopped', value: 'yes' },
      });
    }

    if (run.status === 'KILLED_AUTO') {
      alerts.push({
        ...base,
        severity: 'warning',
        kind: 'auto-killed',
        key: `${run.runId}:auto-killed`,
        title: `Auto-killed — ${label}`,
        detail: run.statusDetail ?? 'Run auto-killed by a safety threshold.',
        metric:
          availPct != null
            ? { label: 'Availability', value: `${availPct}%` }
            : { label: 'Status', value: 'auto-killed' },
      });
    }

    if (typeof run.wrs?.wrs === 'number' && run.wrs.wrs < LOW_WRS_THRESHOLD) {
      alerts.push({
        ...base,
        severity: 'warning',
        kind: 'low-wrs',
        key: `${run.runId}:low-wrs`,
        title: `Low WRS ${run.wrs.wrs} (${run.wrs.level}) — ${label}`,
        detail: `WEDOS Resilience Score ${run.wrs.wrs} is below ${LOW_WRS_THRESHOLD}. Protection may be degraded, or a template misbehaving.`,
        metric: { label: 'WRS', value: `${run.wrs.wrs} (${run.wrs.level})` },
      });
    }

    if (run.confidence?.degraded) {
      const lag = run.confidence.peakEventLoopLagMs;
      alerts.push({
        ...base,
        severity: 'info',
        kind: 'degraded',
        key: `${run.runId}:degraded`,
        title: `Measurement degraded — ${label}`,
        detail:
          run.confidence.reasons[0] ??
          'The generator host may have been the bottleneck; treat the WRS with caution.',
        metric:
          lag != null
            ? { label: 'Event-loop lag', value: `${Math.round(lag)}ms` }
            : { label: 'Confidence', value: 'degraded' },
      });
    }
  }

  return alerts.slice(0, limit);
}
