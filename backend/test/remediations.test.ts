import { describe, expect, it } from 'vitest';
import { deriveRemediations, aggregateRemediations } from '../src/modules/reports/remediations.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

function campaign(id: string): Campaign {
  return { id, name: id, target: 'https://staging.example.com/' } as unknown as Campaign;
}
function run(o: {
  status: CampaignRun['status'];
  wrs: number;
  level: string;
  detection?: number;
  mitigation?: number;
  availability?: number;
  collateral?: number;
  available: number;
  samples: number;
  estimated?: boolean;
  ttd?: number;
  ttm?: number;
  failures?: string[];
}): CampaignRun {
  return {
    campaignId: 'c',
    status: o.status,
    wrs: {
      detection: o.detection ?? 100,
      mitigation: o.mitigation ?? 100,
      availability: o.availability ?? 100,
      collateral: o.collateral ?? 100,
      wrs: o.wrs,
      level: o.level,
      estimated: o.estimated ?? false,
    },
    probe: { samples: o.samples, available: o.available, successful: o.available },
    protection:
      o.ttd != null ? { detectionTimeSec: o.ttd, mitigationTimeSec: o.ttm ?? 0 } : undefined,
    acceptance: o.failures ? { verdict: 'FAIL', failures: o.failures } : undefined,
    generator: { actualRps: 100 },
  } as unknown as CampaignRun;
}

describe('remediations engine', () => {
  it('returns nothing for a clean run', () => {
    const rem = deriveRemediations(
      campaign('c'),
      run({ status: 'COMPLETED', wrs: 97, level: 'A+', available: 100, samples: 100 }),
    );
    expect(rem).toEqual([]);
  });

  it('flags an auto-killed run as a critical availability loss', () => {
    const rem = deriveRemediations(
      campaign('c'),
      run({ status: 'KILLED_AUTO', wrs: 20, level: 'F', available: 0, samples: 20 }),
    );
    expect(rem[0].severity).toBe('critical');
    expect(rem[0].id).toBe('availability-loss');
    // Critical is ranked first.
    expect(rem.map((r) => r.severity)[0]).toBe('critical');
    // Low WRS also surfaces.
    expect(rem.some((r) => r.id === 'low-wrs')).toBe(true);
  });

  it('flags collateral, slow detection and slow mitigation with concrete advice', () => {
    const rem = deriveRemediations(
      campaign('c'),
      run({
        status: 'COMPLETED',
        wrs: 72,
        level: 'B',
        collateral: 60,
        detection: 40,
        mitigation: 50,
        available: 100,
        samples: 100,
        ttd: 40,
        ttm: 60,
      }),
    );
    const ids = rem.map((r) => r.id);
    expect(ids).toContain('collateral');
    expect(ids).toContain('slow-detection');
    expect(ids).toContain('slow-mitigation');
    expect(rem.find((r) => r.id === 'collateral')!.remediation).toMatch(
      /independent origin and protection logs/i,
    );
  });

  it('recommends wiring the scrubber when the WRS is estimated', () => {
    const rem = deriveRemediations(
      campaign('c'),
      run({
        status: 'COMPLETED',
        wrs: 88,
        level: 'A',
        available: 100,
        samples: 100,
        estimated: true,
      }),
    );
    expect(rem.some((r) => r.id === 'estimated-wrs')).toBe(true);
    expect(rem.find((r) => r.id === 'estimated-wrs')!.severity).toBe('low');
  });

  it('surfaces SLO failures individually', () => {
    const rem = deriveRemediations(
      campaign('c'),
      run({
        status: 'COMPLETED',
        wrs: 80,
        level: 'A',
        available: 100,
        samples: 100,
        failures: ['p95 latency 900ms > 500ms'],
      }),
    );
    expect(rem.some((r) => r.weakness.includes('p95 latency'))).toBe(true);
  });

  it('aggregates across runs, dedupes by id and counts affected', () => {
    const runs = [
      {
        campaign: campaign('a'),
        run: run({ status: 'KILLED_AUTO', wrs: 20, level: 'F', available: 0, samples: 10 }),
      },
      {
        campaign: campaign('b'),
        run: run({ status: 'KILLED_AUTO', wrs: 25, level: 'F', available: 0, samples: 10 }),
      },
      {
        campaign: campaign('c'),
        run: run({ status: 'COMPLETED', wrs: 96, level: 'A+', available: 100, samples: 100 }),
      },
    ];
    const agg = aggregateRemediations(runs);
    const loss = agg.find((r) => r.id === 'availability-loss');
    expect(loss).toBeTruthy();
    expect(loss!.affected).toBe(2);
    expect(agg[0].severity).toBe('critical');
  });
});

it('requires probe evidence and real reported timings before claiming a measured weakness', () => {
  const missing = run({
    status: 'COMPLETED',
    wrs: 40,
    level: 'D',
    available: 0,
    samples: 0,
    detection: 10,
    mitigation: 10,
    estimated: true,
  });
  const items = deriveRemediations(campaign('missing'), missing);
  expect(items.some((x) => x.id === 'probe-evidence')).toBe(true);
  expect(
    items.some((x) => ['availability-loss', 'slow-detection', 'slow-mitigation'].includes(x.id)),
  ).toBe(false);
  expect(items.map((x) => x.remediation).join(' ')).not.toContain(
    'pass/fail becomes authoritative',
  );
});
