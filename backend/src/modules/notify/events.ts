import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import type { WrsSeries } from '../wrs/history.js';
import type { NotificationEvent, NotificationField, Severity } from './types.js';

/** Slack attachment colour per severity. */
const COLOR: Record<Severity, string> = {
  info: '#2eb67d',
  warning: '#ecb22e',
  critical: '#e01e5a',
};

function hostOf(target: string): string {
  try {
    return new URL(target).hostname;
  } catch {
    return target;
  }
}

/**
 * Builds the notifications to emit for a finished run: one for the outcome
 * (completed / killed) and, when the target's series shows a regression, an
 * extra regression alert. Pure: no I/O, so it is fully unit-tested.
 */
export function buildRunNotifications(
  campaign: Campaign,
  run: CampaignRun,
  series?: WrsSeries,
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

  if (run.status === 'COMPLETED') {
    events.push({
      kind: 'campaign.completed',
      severity: 'info',
      title: `✅ Campaign completed — ${campaign.name}`,
      text: `“${campaign.name}” finished against ${host}: WRS ${run.wrs.wrs} (${run.wrs.level}).`,
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
        ? `“${campaign.name}” hit the automatic kill switch against ${host} (target unavailable).`
        : `“${campaign.name}” was stopped manually against ${host}.`,
      at,
      campaignId: campaign.id,
      fields: baseFields,
    });
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
