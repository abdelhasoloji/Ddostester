import { describe, it, expect } from 'vitest';
import { deriveAlerts, deriveRegressions } from '../src/modules/alerts/derive.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

const campaign = (id: string, name: string): Campaign =>
  ({ id, name, target: 'https://bank.cz' }) as unknown as Campaign;

const run = (over: Partial<CampaignRun> & { runId: string; campaignId: string }): CampaignRun =>
  ({
    status: 'COMPLETED',
    generator: { finishedAt: '2026-09-10T00:00:00.000Z', hardStopped: false } as never,
    wrs: { wrs: 95, level: 'A+' } as never,
    ...over,
  }) as CampaignRun;

describe('deriveAlerts', () => {
  const campaigns = [campaign('c1', 'burst-resilience')];

  it('returns nothing for a clean high-WRS run', () => {
    const alerts = deriveAlerts([run({ runId: 'r1', campaignId: 'c1' })], campaigns);
    expect(alerts).toHaveLength(0);
  });

  it('flags a tarpit (hard-stopped) run', () => {
    const alerts = deriveAlerts(
      [
        run({
          runId: 'r1',
          campaignId: 'c1',
          generator: { finishedAt: 'z', hardStopped: true } as never,
        }),
      ],
      campaigns,
    );
    expect(alerts.some((a) => a.kind === 'tarpit' && a.title.includes('burst-resilience'))).toBe(
      true,
    );
  });

  it('flags a low WRS', () => {
    const alerts = deriveAlerts(
      [run({ runId: 'r1', campaignId: 'c1', wrs: { wrs: 55, level: 'F' } as never })],
      campaigns,
    );
    const low = alerts.find((a) => a.kind === 'low-wrs');
    expect(low).toBeTruthy();
    expect(low?.severity).toBe('warning');
  });

  it('flags an auto-kill and degraded confidence', () => {
    const alerts = deriveAlerts(
      [
        run({
          runId: 'r1',
          campaignId: 'c1',
          status: 'KILLED_AUTO',
          statusDetail: 'availability floor breached',
          confidence: { degraded: true, reasons: ['generator saturated'] },
        }),
      ],
      campaigns,
    );
    expect(alerts.some((a) => a.kind === 'auto-killed')).toBe(true);
    expect(alerts.some((a) => a.kind === 'degraded' && a.severity === 'info')).toBe(true);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      run({ runId: `r${i}`, campaignId: 'c1', wrs: { wrs: 10, level: 'F' } as never }),
    );
    expect(deriveAlerts(many, campaigns, { limit: 3 })).toHaveLength(3);
  });
});

describe('deriveRegressions (E1 — baseline-relative)', () => {
  // Helpers: N runs on the same target (bank.cz), chronological, with wrs/absorption.
  const cps = Array.from({ length: 6 }, (_, i) => campaign(`r${i}`, `run-${i}`));
  const mkRun = (i: number, wrs: number, absorbedRatio: number): CampaignRun =>
    ({
      runId: `run-${i}`,
      campaignId: `r${i}`,
      status: 'COMPLETED',
      generator: {
        finishedAt: `2026-09-10T0${i}:00:00.000Z`,
        hardStopped: false,
        totalRequests: 1000,
        failed: Math.round(absorbedRatio * 1000),
      } as never,
      wrs: { wrs, level: 'A' } as never,
      absorption: { absorbedRatio } as never,
    }) as CampaignRun;

  it('stays inert below the baseline-run minimum', () => {
    const runs = [mkRun(0, 95, 0.8), mkRun(1, 95, 0.8), mkRun(2, 60, 0.1)]; // only 3
    expect(deriveRegressions(runs, cps)).toHaveLength(0);
  });

  it('flags a WRS regression vs the target baseline', () => {
    const runs = [
      mkRun(0, 96, 0.8),
      mkRun(1, 95, 0.8),
      mkRun(2, 97, 0.8),
      mkRun(3, 95, 0.8),
      mkRun(4, 78, 0.8), // latest: 17 pts below ~95.75 baseline
    ];
    const a = deriveRegressions(runs, cps);
    expect(a.some((x) => x.kind === 'wrs-regression' && x.runId === 'run-4')).toBe(true);
  });

  it('flags a protection regression when the edge stops absorbing', () => {
    const runs = [
      mkRun(0, 95, 0.82),
      mkRun(1, 95, 0.8),
      mkRun(2, 95, 0.78),
      mkRun(3, 95, 0.8),
      mkRun(4, 95, 0.15), // latest: absorbed 15% vs ~80% baseline
    ];
    const a = deriveRegressions(runs, cps);
    const reg = a.find((x) => x.kind === 'protection-regression');
    expect(reg).toBeTruthy();
    expect(reg?.runId).toBe('run-4');
  });

  it('no regression when the latest run is in line with baseline', () => {
    const runs = Array.from({ length: 5 }, (_, i) => mkRun(i, 95, 0.8));
    expect(deriveRegressions(runs, cps)).toHaveLength(0);
  });
});
