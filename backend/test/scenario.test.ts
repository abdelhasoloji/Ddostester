import { describe, it, expect } from 'vitest';
import { validateConfig, InvalidConfigError } from '../src/engine/loadTest.js';
import { createCampaign, CampaignError } from '../src/modules/campaigns/service.js';
import type { LoadTestConfig } from '../src/engine/types.js';
import type { CampaignInput } from '../src/modules/campaigns/model.js';

const cfg: LoadTestConfig = {
  url: 'http://localhost/',
  concurrency: 5,
  durationSec: 10,
  maxRps: 100,
  authorized: true,
};

describe('validateConfig phases', () => {
  it('accepte des phases valides', () => {
    expect(() =>
      validateConfig(
        {
          ...cfg,
          phases: [
            { maxRps: 10, durationSec: 5 },
            { maxRps: 50, durationSec: 5 },
          ],
        },
        ['localhost'],
      ),
    ).not.toThrow();
  });
  it('rejette trop de phases', () => {
    const phases = Array.from({ length: 13 }, () => ({ maxRps: 10, durationSec: 1 }));
    expect(() => validateConfig({ ...cfg, phases }, ['localhost'])).toThrow(InvalidConfigError);
  });
  it('rejette une phase à rps nul', () => {
    expect(() =>
      validateConfig({ ...cfg, phases: [{ maxRps: 0, durationSec: 5 }] }, ['localhost']),
    ).toThrow(InvalidConfigError);
  });
});

const base: CampaignInput = {
  name: 'S',
  target: 'http://localhost/',
  probeUrl: 'http://localhost/',
  vector: 'http-get',
  maxRps: 1,
  concurrency: 5,
  maxDurationSec: 1,
  createdBy: 'e',
  authorized: true,
};

describe('createCampaign scenario', () => {
  it('normalise maxRps/durée depuis le scénario', () => {
    const c = createCampaign(
      {
        ...base,
        scenario: [
          { maxRps: 10, durationSec: 20 },
          { maxRps: 40, durationSec: 10 },
        ],
      },
      ['localhost'],
    );
    expect(c.maxRps).toBe(40);
    expect(c.maxDurationSec).toBe(30);
  });
  it('refuse un scénario dépassant le plafond de durée', () => {
    expect(() =>
      createCampaign({ ...base, scenario: [{ maxRps: 10, durationSec: 1000 }] }, ['localhost']),
    ).toThrow(CampaignError);
  });
  it('refuse une phase au-dessus du plafond RPS', () => {
    expect(() =>
      createCampaign({ ...base, scenario: [{ maxRps: 99999, durationSec: 5 }] }, ['localhost']),
    ).toThrow(CampaignError);
  });
});
