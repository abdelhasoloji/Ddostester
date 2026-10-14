import { describe, expect, it, vi } from 'vitest';
import { createCampaign } from '../src/modules/campaigns/service.js';
const input = {
  name: 'lab',
  createdBy: 'owner@test',
  authorized: true,
  target: 'http://lab-target:8080/health',
  probeUrl: 'http://lab-target:8080/health',
  vector: 'http-get' as const,
  agent: 'fleet',
  probeVantage: 'remote' as const,
  maxRps: 15,
  concurrency: 6,
  maxDurationSec: 30,
};
const choices = [
  {
    id: 'fleet',
    multiPhase: false,
    flowCapable: false,
    correlationCapable: false,
    endpointCapable: false,
  },
];
describe('fleet governance before transport', () => {
  it('validates explicit persistent device selections and retains the shared budget', () => {
    vi.stubEnv('FLEET_MISSIONS_ENABLED', '1');
    try {
      const selected = { ...input, fleetDeviceIds: ['one'], maxRps: 1, concurrency: 1 };
      expect(createCampaign(selected, ['lab-target'], choices).fleetDeviceIds).toEqual(['one']);
      for (const ids of [[], ['one', 'one'], ['a', 'b', 'c', 'd']])
        expect(() =>
          createCampaign({ ...selected, fleetDeviceIds: ids }, ['lab-target'], choices),
        ).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('accepts a governed lab envelope without making a request', () => {
    expect(createCampaign(input, ['lab-target'], choices).status).toBe('PENDING_APPROVAL');
  });
  it.each([
    { maxRps: 16 },
    { concurrency: 7 },
    { maxDurationSec: 61 },
    { calibrate: true },
    { target: 'http://lab-target:8080/api/work.php' },
    { headers: { Authorization: 'not-forwarded' } },
  ])('refuses unsupported settings %j', (over) => {
    expect(() => createCampaign({ ...input, ...over }, ['lab-target'], choices)).toThrow();
  });
  it('does not permit spoofing the server-issued campaign tag', () => {
    expect(() =>
      createCampaign(
        { ...input, headers: { 'x-wedos-test': 'other-campaign' } },
        ['lab-target'],
        choices,
      ),
    ).toThrow(/reserved/);
  });
});
