import { describe, it, expect } from 'vitest';
import { deriveAlerts } from '../src/modules/alerts/derive.js';
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
