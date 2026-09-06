import { describe, expect, it } from 'vitest';
import {
  buildRunNotifications,
  detectBaselineDrift,
  genericPayload,
  slackPayload,
} from '../src/modules/notify/events.js';
import type { BaselineMetrics } from '../src/modules/campaigns/baseline.js';
import {
  createNotifier,
  noopNotifier,
  notifyConfigFromEnv,
} from '../src/modules/notify/notifier.js';
import type { NotificationEvent } from '../src/modules/notify/types.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
import type { WrsSeries } from '../src/modules/wrs/history.js';

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'c1',
    name: 'Nightly staging check',
    target: 'https://staging.example.com/',
    probeUrl: 'https://staging.example.com/health',
    vector: 'http-get',
    concurrency: 10,
    maxRps: 100,
    maxDurationSec: 60,
    authorized: true,
    status: 'COMPLETED',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Campaign;
}

function run(overrides: Partial<CampaignRun> = {}): CampaignRun {
  return {
    runId: 'r1',
    campaignId: 'c1',
    status: 'COMPLETED',
    generator: {
      id: 'r1',
      finishedAt: '2026-09-05T18:00:00.000Z',
      totalRequests: 1000,
      failed: 3,
    },
    probe: { samples: 100, available: 99, successful: 99, errorRate5xx: 0 },
    wrs: { wrs: 92, level: 'A' },
    ...overrides,
  } as CampaignRun;
}

describe('buildRunNotifications', () => {
  it('emits a completion event for a completed run', () => {
    const events = buildRunNotifications(campaign(), run());
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('campaign.completed');
    expect(events[0].severity).toBe('info');
    expect(events[0].fields.find((f) => f.label === 'Target')?.value).toBe('staging.example.com');
  });

  it('emits a critical kill event for an auto-killed run', () => {
    const events = buildRunNotifications(campaign(), run({ status: 'KILLED_AUTO' }));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('campaign.killed');
    expect(events[0].severity).toBe('critical');
  });

  it('emits a warning kill event for a manually stopped run', () => {
    const events = buildRunNotifications(campaign(), run({ status: 'KILLED_MANUAL' }));
    expect(events[0].kind).toBe('campaign.killed');
    expect(events[0].severity).toBe('warning');
  });

  it('adds a regression event when the series regressed', () => {
    const series: WrsSeries = {
      target: 'staging.example.com',
      points: [],
      regression: true,
      drop: 18,
    };
    const events = buildRunNotifications(campaign(), run(), series);
    expect(events.map((e) => e.kind)).toContain('wrs.regression');
    const reg = events.find((e) => e.kind === 'wrs.regression')!;
    expect(reg.text).toContain('18 points');
  });

  it('does not add a regression event when there is no regression', () => {
    const series: WrsSeries = {
      target: 'staging.example.com',
      points: [],
      regression: false,
      drop: 2,
    };
    const events = buildRunNotifications(campaign(), run(), series);
    expect(events.map((e) => e.kind)).not.toContain('wrs.regression');
  });

  it('adds a baseline-drift event when nominal health degraded vs the previous run', () => {
    const prev: BaselineMetrics = {
      samples: 3,
      availabilityPct: 100,
      latencyMs: { p50: 5, p95: 10 },
    };
    const withBaseline = run({
      baseline: { samples: 3, availabilityPct: 90, latencyMs: { p50: 6, p95: 12 } },
    });
    const events = buildRunNotifications(campaign(), withBaseline, undefined, prev);
    const drift = events.find((e) => e.kind === 'baseline.drift');
    expect(drift).toBeDefined();
    expect(drift!.text).toContain('availability');
  });

  it('does not add a baseline-drift event when the baseline is stable', () => {
    const prev: BaselineMetrics = {
      samples: 3,
      availabilityPct: 100,
      latencyMs: { p50: 5, p95: 10 },
    };
    const withBaseline = run({
      baseline: { samples: 3, availabilityPct: 100, latencyMs: { p50: 5, p95: 11 } },
    });
    const events = buildRunNotifications(campaign(), withBaseline, undefined, prev);
    expect(events.map((e) => e.kind)).not.toContain('baseline.drift');
  });
});

describe('detectBaselineDrift', () => {
  const base: BaselineMetrics = {
    samples: 3,
    availabilityPct: 100,
    latencyMs: { p50: 5, p95: 40 },
  };

  it('flags an availability drop of ≥ 5 points', () => {
    const v = detectBaselineDrift(base, { ...base, availabilityPct: 94 });
    expect(v.drifted).toBe(true);
    expect(v.availabilityDeltaPct).toBe(-6);
  });

  it('flags a p95 latency rise beyond 25% and 20 ms', () => {
    const v = detectBaselineDrift(base, { ...base, latencyMs: { p50: 5, p95: 70 } });
    expect(v.drifted).toBe(true);
    expect(v.latencyP95DeltaMs).toBe(30);
  });

  it('ignores a small latency rise under the absolute floor', () => {
    const v = detectBaselineDrift(
      { ...base, latencyMs: { p50: 1, p95: 4 } },
      { ...base, latencyMs: { p50: 1, p95: 8 } },
    );
    // +4 ms is a big % but below the 20 ms floor → not drift.
    expect(v.drifted).toBe(false);
  });

  it('is stable when nothing moved', () => {
    expect(detectBaselineDrift(base, base).drifted).toBe(false);
  });
});

describe('payload formatters', () => {
  const event: NotificationEvent = {
    kind: 'campaign.completed',
    severity: 'warning',
    title: 'title',
    text: 'text',
    at: '2026-09-05T18:00:00.000Z',
    fields: [{ label: 'Target', value: 'x' }],
  };

  it('slackPayload maps severity to a colour and fields to short attachment fields', () => {
    const p = slackPayload(event) as { attachments: { color: string; fields: unknown[] }[] };
    expect(p.attachments[0].color).toBe('#ecb22e');
    expect(p.attachments[0].fields).toHaveLength(1);
  });

  it('genericPayload tags the product and preserves the event', () => {
    const p = genericPayload(event) as { product: string; kind: string };
    expect(p.product).toBe('wedos-shieldtest');
    expect(p.kind).toBe('campaign.completed');
  });
});

describe('notifyConfigFromEnv', () => {
  it('reads sink URLs and the event filter', () => {
    const cfg = notifyConfigFromEnv({
      NOTIFY_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
      NOTIFY_WEBHOOK_URL: 'https://example.com/hook',
      NOTIFY_EVENTS: 'wrs.regression, campaign.killed , bogus',
    } as NodeJS.ProcessEnv);
    expect(cfg.slackUrl).toBe('https://hooks.slack.com/services/x');
    expect(cfg.webhookUrl).toBe('https://example.com/hook');
    expect(cfg.events).toEqual(['wrs.regression', 'campaign.killed']);
  });

  it('leaves events undefined when none configured', () => {
    const cfg = notifyConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.events).toBeUndefined();
    expect(cfg.slackUrl).toBeUndefined();
  });
});

describe('createNotifier', () => {
  it('returns the no-op notifier when no sink is configured', () => {
    expect(createNotifier({})).toBe(noopNotifier);
  });

  it('rejects a non-http sink URL', () => {
    expect(() => createNotifier({ slackUrl: 'ftp://bad' })).toThrow(/http/);
  });

  it('delivers to both sinks via the injected post function', async () => {
    const calls: { url: string; payload: unknown }[] = [];
    const notifier = createNotifier(
      {
        slackUrl: 'https://hooks.slack.com/services/x',
        webhookUrl: 'https://example.com/hook',
      },
      async (url, payload) => void calls.push({ url, payload }),
    );
    expect(notifier.sinks).toEqual(['slack', 'webhook']);
    await notifier.notify({
      kind: 'campaign.completed',
      severity: 'info',
      title: 't',
      text: 'x',
      at: '2026-09-05T18:00:00.000Z',
      fields: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).toContain('https://hooks.slack.com/services/x');
  });

  it('respects the event filter', async () => {
    const calls: string[] = [];
    const notifier = createNotifier(
      { webhookUrl: 'https://example.com/hook', events: ['wrs.regression'] },
      async (url) => void calls.push(url),
    );
    await notifier.notify({
      kind: 'campaign.completed',
      severity: 'info',
      title: 't',
      text: 'x',
      at: '2026-09-05T18:00:00.000Z',
      fields: [],
    });
    expect(calls).toHaveLength(0);
  });

  it('never throws when a sink fails', async () => {
    const notifier = createNotifier({ webhookUrl: 'https://example.com/hook' }, async () => {
      throw new Error('boom');
    });
    await expect(
      notifier.notify({
        kind: 'campaign.completed',
        severity: 'info',
        title: 't',
        text: 'x',
        at: '2026-09-05T18:00:00.000Z',
        fields: [],
      }),
    ).resolves.toBeUndefined();
  });
});
