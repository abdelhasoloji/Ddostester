import { describe, it, expect } from 'vitest';
import { buildAbsorptionSummary } from '../src/modules/observability/summary.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

const campaign = (id: string, target: string, vector: string): Campaign =>
  ({ id, name: id, target, vector }) as unknown as Campaign;

const run = (
  campaignId: string,
  at: string,
  wrs: number,
  absorption: Partial<NonNullable<CampaignRun['absorption']>>,
): CampaignRun =>
  ({
    runId: `${campaignId}-${at}`,
    campaignId,
    status: 'COMPLETED',
    generator: { finishedAt: at, totalRequests: 1000, failed: 0 } as never,
    wrs: { wrs, level: 'A' } as never,
    absorption: { absorbedRatio: 0, ...absorption } as never,
  }) as unknown as CampaignRun;

describe('buildAbsorptionSummary (S1)', () => {
  it('rolls up per (target, vector) with last + mean stats', () => {
    const campaigns = [
      campaign('c1', 'https://bank.cz', 'http-get'),
      campaign('c2', 'https://bank.cz', 'http-get'),
      campaign('c3', 'https://bank.cz', 'http-post'),
    ];
    const runs = [
      run('c1', '2026-09-10T01:00:00Z', 90, { absorbedRatio: 0.6 }),
      run('c2', '2026-09-10T02:00:00Z', 96, {
        absorbedRatio: 0.8,
        tarpitRatio: 0.7,
        rejectedRatio: 0.1,
      }),
      run('c3', '2026-09-10T03:00:00Z', 95, { absorbedRatio: 0.1, offeredShortfall: 0.5 }),
    ];
    const rows = buildAbsorptionSummary(runs, campaigns);

    const get = (v: string) => rows.find((r) => r.vector === v)!;
    // http-get: two runs, latest is c2 (later timestamp).
    expect(get('http-get').runs).toBe(2);
    expect(get('http-get').lastWrs).toBe(96);
    expect(get('http-get').meanWrs).toBe(93); // (90+96)/2
    expect(get('http-get').lastAbsorbedPct).toBe(80);
    expect(get('http-get').meanAbsorbedPct).toBe(70); // (60+80)/2
    expect(get('http-get').lastTarpitPct).toBe(70);
    expect(get('http-get').lastRejectedPct).toBe(10);
    // http-post: one run, backpressure captured.
    expect(get('http-post').lastOfferedShortfallPct).toBe(50);
  });

  it('sorts most-absorbed first and ignores runs with no matching campaign', () => {
    const campaigns = [
      campaign('c1', 'https://a.cz', 'http-get'),
      campaign('c2', 'https://b.cz', 'http-get'),
    ];
    const runs = [
      run('c1', '2026-09-10T01:00:00Z', 90, { absorbedRatio: 0.2 }),
      run('c2', '2026-09-10T01:00:00Z', 90, { absorbedRatio: 0.9 }),
      run('orphan', '2026-09-10T01:00:00Z', 90, { absorbedRatio: 0.99 }), // no campaign
    ];
    const rows = buildAbsorptionSummary(runs, campaigns);
    expect(rows).toHaveLength(2);
    expect(rows[0].target).toBe('https://b.cz'); // 90% absorbed leads
  });
});
