import { afterEach, it, expect, vi } from 'vitest';
import { drsCatalog } from '../src/modules/drs/catalog.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
const input = {
  name: 'DRS GET',
  createdBy: 'owner@test',
  authorized: true,
  target: 'http://lab-target:8080/',
  probeUrl: 'http://lab-target:8080/',
  vector: 'http-get' as const,
  agent: 'fleet',
  fleetDeviceIds: ['one'],
  maxRps: 3,
  concurrency: 3,
  maxDurationSec: 20,
  drsProfileId: 'cra-l7-get-flood',
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
afterEach(() => vi.unstubAllEnvs());
it('exposes only the archived official DRS catalogue and separates registry from execution capacity', () => {
  const c = drsCatalog();
  expect(c.profiles).toHaveLength(131);
  expect(c.profiles.filter((p) => p.supported).map((p) => p.id)).toHaveLength(7);
  expect(c.inventoryCaps.maxDevices).toBe(5000);
  expect(c.inventoryCaps.maxSites).toBe(100);
  expect(c.executionCaps.maxAgents).toBe(3);
});
it('retains a DRS marker and enforces Fleet with no fallback or cap expansion', () => {
  vi.stubEnv('CAMPAIGN_CATALOG', 'drs-fleet');
  vi.stubEnv('FLEET_MISSIONS_ENABLED', '1');
  expect(createCampaign(input, ['lab-target'], choices).drsProfileId).toBe(input.drsProfileId);
  for (const changes of [
    { drsProfileId: undefined },
    { drsProfileId: 'cra-l7-post-flood' },
    { agent: 'builtin' },
    { fleetDeviceIds: [] },
    { maxRps: 16 },
    { maxDurationSec: 61 },
    { vector: 'http-post' },
    { archived: true },
  ])
    expect(() =>
      createCampaign({ ...input, ...changes } as typeof input, ['lab-target'], choices),
    ).toThrow();
});
