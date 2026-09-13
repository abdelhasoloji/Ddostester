import { describe, it, expect } from 'vitest';
import { deriveImpact } from '../src/modules/alerts/impact.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

const campaign = (id: string, name: string): Campaign =>
  ({ id, name, target: 'https://bank.cz' }) as unknown as Campaign;

const run = (over: Partial<CampaignRun> & { runId: string; campaignId: string }): CampaignRun =>
  ({
    status: 'COMPLETED',
    generator: { finishedAt: 'z' } as never,
    probe: { samples: 10, available: 10 } as never,
    wrs: { wrs: 97 } as never,
    ...over,
  }) as CampaignRun;

const campaigns = [
  campaign('c1', 'GET flood'),
  campaign('c2', 'POST break'),
  campaign('c3', 'clean'),
];

describe('deriveImpact (E16)', () => {
  it('lists only runs that genuinely floored the target, worst first', () => {
    const runs = [
      run({ runId: 'r1', campaignId: 'c3' }), // clean 100% avail → excluded
      run({
        runId: 'r2',
        campaignId: 'c1',
        probe: { samples: 10, available: 5 } as never, // 50% avail → impact
      }),
      run({
        runId: 'r3',
        campaignId: 'c2',
        breakingPoint: { reached: true, rps: 400, sustainedRps: 300 } as never,
      }),
    ];
    const impact = deriveImpact(runs, campaigns);
    const ids = impact.map((i) => i.runId);
    expect(ids).toContain('r2');
    expect(ids).toContain('r3');
    expect(ids).not.toContain('r1'); // the clean run is not an impact
    expect(impact[0].severity).toBeGreaterThanOrEqual(impact[impact.length - 1].severity);
  });

  it('EXCLUDES probe-contention false negatives (PF1) — a serving target is not an impact', () => {
    const runs = [
      run({
        runId: 'r1',
        campaignId: 'c1',
        status: 'KILLED_AUTO',
        probeContended: true, // probe lost the race; target was serving
        probe: { samples: 10, available: 0 } as never,
      }),
    ];
    expect(deriveImpact(runs, campaigns)).toHaveLength(0);
  });

  it('reports the breaking rps and the highest rate sustained', () => {
    const runs = [
      run({
        runId: 'r3',
        campaignId: 'c2',
        breakingPoint: { reached: true, rps: 450, sustainedRps: 320 } as never,
      }),
    ];
    const [e] = deriveImpact(runs, campaigns);
    expect(e.breakingRps).toBe(450);
    expect(e.sustainedRps).toBe(320);
  });
});
