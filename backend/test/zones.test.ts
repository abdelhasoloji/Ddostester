import { describe, it, expect } from 'vitest';
import { buildZones, zoneHost } from '../src/modules/zones/zones.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

function campaign(id: string, over: Partial<Campaign> = {}): Campaign {
  return {
    id,
    name: id,
    status: 'COMPLETED',
    target: 'https://bank.cz/',
    probeUrl: 'https://bank.cz/',
    vector: 'http-get',
    maxRps: 100,
    concurrency: 10,
    maxDurationSec: 60,
    authorized: true,
    createdBy: 'eng',
    createdAt: '2026-09-10T00:00:00Z',
    ...over,
  } as Campaign;
}

// Minimal run carrying only what buildWrsHistory reads (campaignId, generator
// .finishedAt, wrs). Cast to keep the fixture small.
function run(campaignId: string, wrs: number, finishedAt: string): CampaignRun {
  return {
    runId: `${campaignId}-r`,
    campaignId,
    status: 'COMPLETED',
    generator: { finishedAt },
    wrs: { wrs, level: wrs >= 80 ? 'A' : wrs >= 70 ? 'B' : 'C' },
  } as unknown as CampaignRun;
}

describe('zoneHost', () => {
  it('normalises URLs and bare hosts to the host', () => {
    expect(zoneHost('https://bank.cz/x')).toBe('bank.cz');
    expect(zoneHost('bank.cz')).toBe('bank.cz');
    expect(zoneHost('http://api.gov.cz:8080/')).toBe('api.gov.cz:8080');
  });
});

describe('buildZones', () => {
  it('groups the estate by protected host, counting campaigns and suites', () => {
    const zones = buildZones(
      [
        campaign('a', { target: 'https://bank.cz/', suiteId: 's1' }),
        campaign('b', { target: 'https://bank.cz/login', suiteId: 's1' }),
        campaign('c', { target: 'https://shop.eu/', status: 'RUNNING' }),
      ],
      [],
    );
    expect(zones.map((z) => z.host).sort()).toEqual(['bank.cz', 'shop.eu']);
    const bank = zones.find((z) => z.host === 'bank.cz')!;
    expect(bank.campaigns).toBe(2);
    expect(bank.suites).toBe(1); // both in s1
    expect(bank.running).toBe(false);
    const shop = zones.find((z) => z.host === 'shop.eu')!;
    expect(shop.running).toBe(true); // a RUNNING campaign
  });

  it('parses the highest DRS reached from campaign names', () => {
    const [z] = buildZones(
      [
        campaign('a', { name: 'DRS L7 — GET-Flood (DRS3)' }),
        campaign('b', { name: 'DRS L7 — MultiVector (DRS5)' }),
      ],
      [],
    );
    expect(z.maxDrs).toBe(5);
  });

  it('fills WRS posture from the zone runs (last, mean, level, last test time)', () => {
    const zones = buildZones(
      [campaign('a', { target: 'https://bank.cz/' })],
      [run('a', 60, '2026-09-11T10:00:00Z'), run('a', 90, '2026-09-11T12:00:00Z')],
    );
    const bank = zones[0];
    expect(bank.lastWrs).toBe(90); // newest by finishedAt
    expect(bank.lastLevel).toBe('A');
    expect(bank.meanWrs).toBe(75); // (60+90)/2
    expect(bank.lastTestAt).toBeTruthy();
  });

  it('is empty-safe', () => {
    expect(buildZones([], [])).toEqual([]);
  });
});
