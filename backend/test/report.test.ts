import { describe, expect, it } from 'vitest';
import { renderCampaignReportHtml } from '../src/modules/reports/report.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 'c-1',
    name: 'Baseline probe',
    target: 'https://staging.example.com/',
    probeUrl: 'https://staging.example.com/health',
    vector: 'http-get',
    createdBy: 'eng@wedos',
    approvedBy: 'off@wedos',
    maxRps: 300,
    concurrency: 50,
    maxDurationSec: 120,
    ...over,
  } as unknown as Campaign;
}

function run(over: Record<string, unknown> = {}): CampaignRun {
  const timeline = Array.from({ length: 12 }, (_, t) => ({
    t,
    rps: t * 25,
    sent: t * 100,
    failed: t,
    probe5xx: 0,
    availPct: 100,
  }));
  return {
    runId: 'run-abcdef12-0000',
    campaignId: 'c-1',
    status: 'COMPLETED',
    generator: {
      totalRequests: 30000,
      successful: 29900,
      failed: 100,
      actualRps: 250,
      finishedAt: new Date().toISOString(),
      latencyMs: { p50: 40, p95: 150, p99: 400 },
    },
    probe: {
      samples: 120,
      available: 120,
      errorRate5xx: 0,
      latencyMs: { p50: 55, p95: 200, p99: 500 },
    },
    wrs: {
      wrs: 88,
      level: 'A',
      detection: 0.7,
      mitigation: 0.7,
      availability: 1,
      collateral: 0.95,
      estimated: false,
    },
    timeline,
    ...over,
  } as unknown as CampaignRun;
}

describe('per-campaign report', () => {
  const html = renderCampaignReportHtml(campaign(), run());

  it('renders the designed sections and charts', () => {
    expect(html).toContain('Campaign resilience report');
    expect(html).toContain('Confidential — WEDOS internal');
    expect(html).toContain('class="lead"'); // management summary
    expect(html).toContain('At a glance');
    expect(html).toContain('chart-gauge'); // WRS gauge
    expect(html).toContain('Traffic over time');
    expect(html).toContain('chart-timeline'); // rps + availability timelines
    expect(html).toContain('chart-hbars'); // WRS components + latency
    expect(html).toContain('Latency profile');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('summarises the run in prose with the score and availability', () => {
    expect(html).toMatch(/WRS 88 \(A\)/);
    expect(html).toContain('req/s');
    expect(html).toContain('availability held');
  });

  it('shows the kill callout and estimated caveat when applicable', () => {
    const killed = renderCampaignReportHtml(
      campaign(),
      run({
        status: 'KILLED_AUTO',
        statusDetail: 'Auto-killed: target unavailable ≥30 s.',
        wrs: {
          wrs: 40,
          level: 'F',
          detection: 0.5,
          mitigation: 0.5,
          availability: 0.3,
          collateral: 0.6,
          estimated: true,
        },
        probe: {
          samples: 60,
          available: 20,
          errorRate5xx: 30,
          latencyMs: { p50: 200, p95: 900, p99: 2000 },
        },
      }),
    );
    expect(killed).toContain('Auto-killed: target unavailable');
    expect(killed).toContain('WRS estimated');
    expect(killed).not.toMatch(/NaN|undefined/);
  });

  it('degrades gracefully when a run has no timeline', () => {
    const noTl = renderCampaignReportHtml(campaign(), run({ timeline: [] }));
    expect(noTl).toContain('No time-series captured');
    expect(noTl).not.toMatch(/NaN|undefined/);
  });

  it('explains a flood the target absorbed (low success + heavy throttle), not just the score', () => {
    const blocked = renderCampaignReportHtml(
      campaign({ maxRps: 500, name: 'Random-URL wave' }),
      run({
        generator: {
          totalRequests: 2028,
          successful: 0,
          failed: 2028,
          actualRps: 11,
          finishedAt: new Date().toISOString(),
          latencyMs: { p50: 6500, p95: 9600, p99: 9950 },
          statusCounts: { '4xx': 511 },
          errors: { AbortError: 1517 },
        },
        timeline: Array.from({ length: 12 }, (_, t) => ({
          t,
          rps: 11,
          sent: t * 11,
          failed: t * 11,
          probe5xx: 0,
          availPct: 100,
        })),
      }),
    );
    // The contradiction (high score, zero success) is explained, not left bare.
    expect(blocked).toContain('protection absorbed the load');
    expect(blocked).toContain('rejected by the edge'); // failure split surfaced
    // Configured intent is shown, not only the throttled achieved rate.
    expect(blocked).toContain('Configured load');
    expect(blocked).toMatch(/500 req\/s/);
    expect(blocked).not.toMatch(/NaN|undefined/);
  });
});
