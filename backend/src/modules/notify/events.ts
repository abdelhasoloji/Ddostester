import { remoteProbeQualityReasons } from '../reports/confidence.js';
import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { computeBaselineDelta } from '../campaigns/baseline.js';
import type { BaselineMetrics } from '../campaigns/baseline.js';
import type { WrsSeries } from '../wrs/history.js';
import type { NotificationEvent, NotificationField, Severity } from './types.js';
import { hostOf } from '../../util/net.js';

/** Thresholds for a baseline-drift alert (nominal health worsened between runs). */
const DRIFT_AVAIL_DROP_PTS = 5;
const DRIFT_LATENCY_RISE_PCT = 25;
const DRIFT_LATENCY_MIN_RISE_MS = 20;

export interface BaselineDriftVerdict {
  drifted: boolean;
  availabilityDeltaPct: number;
  latencyP95DeltaMs: number;
  reasons: string[];
}

/**
 * Compares a target's nominal baseline between two runs (previous → current).
 * Flags drift when availability dropped by ≥ 5 pts, or p95 latency rose by
 * ≥ 25% and ≥ 20 ms (the absolute floor avoids noise on tiny latencies). Pure.
 */
export function detectBaselineDrift(
  prev: BaselineMetrics,
  curr: BaselineMetrics,
): BaselineDriftVerdict | undefined {
  const d = computeBaselineDelta(prev, {
    availabilityPct: curr.availabilityPct,
    latencyMs: curr.latencyMs,
  });
  if (
    !d ||
    curr.samples === 0 ||
    curr.observation?.complete === false ||
    (curr.quality && remoteProbeQualityReasons(curr.quality).length)
  )
    return undefined;
  const reasons: string[] = [];
  if (d.availabilityDeltaPct <= -DRIFT_AVAIL_DROP_PTS) {
    reasons.push(
      `availability ${d.availabilityDeltaPct} pts (${prev.availabilityPct}% → ${curr.availabilityPct}%)`,
    );
  }
  const risePct = prev.latencyMs.p95 > 0 ? (d.latencyP95DeltaMs / prev.latencyMs.p95) * 100 : 0;
  if (d.latencyP95DeltaMs >= DRIFT_LATENCY_MIN_RISE_MS && risePct >= DRIFT_LATENCY_RISE_PCT) {
    reasons.push(
      `latency p95 +${d.latencyP95DeltaMs} ms (${prev.latencyMs.p95} → ${curr.latencyMs.p95})`,
    );
  }
  return {
    drifted: reasons.length > 0,
    availabilityDeltaPct: d.availabilityDeltaPct,
    latencyP95DeltaMs: d.latencyP95DeltaMs,
    reasons,
  };
}

/** Slack attachment colour per severity. */
const COLOR: Record<Severity, string> = {
  info: '#2eb67d',
  warning: '#ecb22e',
  critical: '#e01e5a',
};

/**
 * Builds the notifications to emit for a finished run: one for the outcome
 * (completed / killed) and, when the target's series shows a regression, an
 * extra regression alert. Pure: no I/O, so it is fully unit-tested.
 */
export function buildRunNotifications(
  campaign: Campaign,
  run: CampaignRun,
  series?: WrsSeries,
  previousBaseline?: BaselineMetrics,
): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  const host = hostOf(campaign.target);
  const at = run.generator.finishedAt;
  const engine = campaign.agent ?? 'builtin-http';
  const total = run.generator.totalRequests;
  const failed = run.generator.failed;
  const availability = run.probe.samples
    ? Math.round((run.probe.available / run.probe.samples) * 100)
    : 100;

  const baseFields: NotificationField[] = [
    { label: 'Target', value: host },
    { label: 'Engine', value: engine },
    { label: 'WRS', value: `${run.wrs.wrs} (${run.wrs.level})` },
    { label: 'Requests', value: `${total} (${failed} failed)` },
    { label: 'Availability', value: `${availability}%` },
  ];
  if (run.acceptance) {
    baseFields.push({ label: 'SLO verdict', value: run.acceptance.verdict });
  }

  if (run.status === 'COMPLETED') {
    const failed_slo = run.acceptance?.verdict === 'FAIL';
    events.push({
      kind: 'campaign.completed',
      severity: failed_slo ? 'warning' : 'info',
      title: failed_slo
        ? `❌ SLO FAILED — ${campaign.name}`
        : `✅ Campaign completed — ${campaign.name}`,
      text: failed_slo
        ? `“${campaign.name}” did not meet its SLO against ${host}: ${run.acceptance!.failures.join('; ')}.`
        : `“${campaign.name}” finished against ${host}: WRS ${run.wrs.wrs} (${run.wrs.level})${run.acceptance ? ' — SLO PASS' : ''}.`,
      at,
      campaignId: campaign.id,
      fields: baseFields,
    });
  } else {
    const auto = run.status === 'KILLED_AUTO';
    events.push({
      kind: 'campaign.killed',
      severity: auto ? 'critical' : 'warning',
      title: `🛑 Campaign ${auto ? 'auto-killed' : 'stopped'} — ${campaign.name}`,
      text: auto
        ? run.baseline?.observation?.complete === false ||
          Boolean(run.baseline?.quality && remoteProbeQualityReasons(run.baseline.quality).length)
          ? `“${campaign.name}” hit the automatic safety stop against ${host} with an uncertain remote baseline; target availability requires independent verification.`
          : `“${campaign.name}” hit the automatic kill switch against ${host} (target unavailable).`
        : `“${campaign.name}” was stopped manually against ${host}.`,
      at,
      campaignId: campaign.id,
      fields: baseFields,
    });
  }

  if (previousBaseline && run.baseline) {
    const drift = detectBaselineDrift(previousBaseline, run.baseline);
    if (drift?.drifted) {
      events.push({
        kind: 'baseline.drift',
        severity: 'warning',
        title: `📉 Baseline drift — ${host}`,
        text: `Nominal health of ${host} degraded since the previous run: ${drift.reasons.join('; ')}.`,
        at,
        campaignId: campaign.id,
        fields: [
          { label: 'Target', value: host },
          { label: 'Δ availability', value: `${drift.availabilityDeltaPct} pts` },
          {
            label: 'Δ latency p95',
            value: `${drift.latencyP95DeltaMs >= 0 ? '+' : ''}${drift.latencyP95DeltaMs} ms`,
          },
        ],
      });
    }
  }

  if (series?.regression) {
    events.push({
      kind: 'wrs.regression',
      severity: 'warning',
      title: `📉 Resilience regression — ${host}`,
      text: `WRS for ${host} dropped by ${series.drop} points versus the previous run (now ${run.wrs.wrs}).`,
      at,
      campaignId: campaign.id,
      fields: [
        { label: 'Target', value: host },
        { label: 'Drop', value: `-${series.drop} points` },
        { label: 'Current WRS', value: `${run.wrs.wrs} (${run.wrs.level})` },
      ],
    });
  }

  return events;
}

/** Slack incoming-webhook payload (text + a coloured attachment with fields). */
export function slackPayload(event: NotificationEvent): unknown {
  return {
    text: event.title,
    attachments: [
      {
        color: COLOR[event.severity],
        title: event.title,
        text: event.text,
        fields: event.fields.map((f) => ({ title: f.label, value: f.value, short: true })),
        footer: 'WEDOS ShieldTest',
        ts: Math.floor(new Date(event.at).getTime() / 1000) || undefined,
      },
    ],
  };
}

/** Generic JSON webhook payload (the event plus a product tag). */
export function genericPayload(event: NotificationEvent): unknown {
  return { product: 'wedos-shieldtest', ...event };
}
