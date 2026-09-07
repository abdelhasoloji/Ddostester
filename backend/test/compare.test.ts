import { describe, expect, it } from 'vitest';
import { renderCompareHtml } from '../src/modules/reports/compare.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

function campaign(id: string, name: string, target: string): Campaign {
  return { id, name, target } as unknown as Campaign;
}
function run(
  campaignId: string,
  o: {
    wrs: number;
    level: string;
    available: number;
    samples: number;
    p95: number;
    status?: CampaignRun['status'];
    protection?: { source?: string; detectionTimeSec: number; mitigationTimeSec: number };
  },
): CampaignRun {
  return {
    runId: `${campaignId}-run`,
    campaignId,
    status: o.status ?? 'COMPLETED',
    wrs: { wrs: o.wrs, level: o.level, estimated: !o.protection },
    probe: {
      samples: o.samples,
      available: o.available,
      latencyMs: { p50: 0, p95: o.p95, p99: 0 },
    },
    generator: { actualRps: 100, finishedAt: new Date().toISOString() },
    protection: o.protection,
  } as unknown as CampaignRun;
}

describe('before/after comparison report', () => {
  const cBefore = campaign('c1', 'Baseline (before DRS)', 'https://127.0.0.1/');
  const cAfter = campaign('c2', 'Baseline (after DRS)', 'https://127.0.0.1/');

  it('reports "Improved" and per-metric deltas when B beats A', () => {
    const a = {
      campaign: cBefore,
      run: run('c1', { wrs: 60, level: 'C', available: 80, samples: 100, p95: 120 }),
    };
    const b = {
      campaign: cAfter,
      run: run('c2', {
        wrs: 92,
        level: 'A',
        available: 100,
        samples: 100,
        p95: 45,
        protection: { source: 'scrubbing', detectionTimeSec: 4, mitigationTimeSec: 11 },
      }),
    };
    const html = renderCompareHtml(a, b);
    expect(html).toContain('Resilience comparison');
    expect(html).toContain('Improved (+32 WRS)');
    expect(html).toContain('+32'); // WRS delta
    expect(html).toContain('+20 pts'); // availability delta
    expect(html).toMatch(/▼ -75 ms/); // p95 improved (down is good)
    expect(html).toContain('4s'); // TTD after
    expect(html).toContain('11s'); // TTM after
  });

  it('reports "Regressed" when B is worse than A', () => {
    const a = {
      campaign: cBefore,
      run: run('c1', { wrs: 90, level: 'A', available: 100, samples: 100, p95: 40 }),
    };
    const b = {
      campaign: cAfter,
      run: run('c2', {
        wrs: 55,
        level: 'C',
        available: 90,
        samples: 100,
        p95: 80,
        status: 'KILLED_AUTO',
      }),
    };
    const html = renderCompareHtml(a, b);
    expect(html).toContain('Regressed (-35 WRS)');
  });
});
