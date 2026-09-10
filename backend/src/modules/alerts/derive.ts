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
  kind: 'tarpit' | 'low-wrs' | 'degraded' | 'auto-killed' | 'not-engaging';
  title: string;
  detail: string;
  campaignId?: string;
  runId: string;
  target?: string;
  at?: string; // ISO (generator.finishedAt when available)
}

/** WRS at/below this is flagged (mirrors the Alertmanager WRSDrop rule). */
export const LOW_WRS_THRESHOLD = 70;

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

  const alerts: Alert[] = [];
  for (const run of sorted.slice(0, recent)) {
    const label = nameOf.get(run.campaignId) ?? run.campaignId;
    const target = targetOf.get(run.campaignId);
    const at = run.generator?.finishedAt;
    const base = { campaignId: run.campaignId, runId: run.runId, target, at };

    if (run.generator?.hardStopped) {
      alerts.push({
        ...base,
        severity: 'warning',
        kind: 'tarpit',
        key: `${run.runId}:tarpit`,
        title: `Target tarpitting — ${label}`,
        detail:
          'A run was force-settled by the hard backstop (the edge held connections past the cap). Protection is biting; achieved load may be understated.',
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
      });
    }

    if (run.confidence?.degraded) {
      alerts.push({
        ...base,
        severity: 'info',
        kind: 'degraded',
        key: `${run.runId}:degraded`,
        title: `Measurement degraded — ${label}`,
        detail:
          run.confidence.reasons[0] ??
          'The generator host may have been the bottleneck; treat the WRS with caution.',
      });
    }
  }

  return alerts.slice(0, limit);
}
