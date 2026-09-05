import { describe, it, expect } from 'vitest';
import { createAgent, agentChoices, describeAgents } from '../src/agents/index.js';
import { createCampaign, CampaignError } from '../src/modules/campaigns/service.js';
import type { CampaignInput } from '../src/modules/campaigns/model.js';

const base: CampaignInput = {
  name: 'c',
  target: 'http://127.0.0.1/health',
  probeUrl: 'http://127.0.0.1/health',
  vector: 'http-get',
  maxRps: 50,
  concurrency: 5,
  maxDurationSec: 30,
  createdBy: 'eng@wedos',
  authorized: true,
};
const hosts = ['127.0.0.1'];

describe('agent registry', () => {
  it('resolves known agents and rejects unknown', () => {
    expect(createAgent('k6')?.name).toBe('k6');
    expect(createAgent('builtin')?.name).toBe('builtin-http');
    expect(createAgent('nope')).toBeUndefined();
    expect(createAgent(undefined)).toBeUndefined();
  });

  it('exposes capabilities per engine', () => {
    const choices = agentChoices();
    expect(choices.find((c) => c.id === 'builtin')?.multiPhase).toBe(true);
    expect(choices.find((c) => c.id === 'k6')?.multiPhase).toBe(true);
    expect(choices.find((c) => c.id === 'locust')?.multiPhase).toBe(false);
    expect(choices.find((c) => c.id === 'jmeter')?.multiPhase).toBe(false);
  });

  it('reports the builtin agent as available', async () => {
    const list = await describeAgents();
    const builtin = list.find((a) => a.id === 'builtin');
    expect(builtin?.available).toBe(true);
    expect(builtin?.name).toBe('builtin-http');
  });
});

describe('createCampaign — engine validation', () => {
  it('accepts a known engine', () => {
    const c = createCampaign({ ...base, agent: 'k6' }, hosts, agentChoices());
    expect(c.agent).toBe('k6');
  });

  it('rejects an unknown engine', () => {
    expect(() => createCampaign({ ...base, agent: 'nope' }, hosts, agentChoices())).toThrow(
      CampaignError,
    );
  });

  it('rejects a multi-phase scenario on a constant-only engine', () => {
    const scenario = [
      { maxRps: 20, durationSec: 5 },
      { maxRps: 40, durationSec: 5 },
    ];
    expect(() =>
      createCampaign({ ...base, agent: 'locust', scenario }, hosts, agentChoices()),
    ).toThrow(CampaignError);
  });

  it('allows a multi-phase scenario on k6', () => {
    const scenario = [
      { maxRps: 20, durationSec: 5 },
      { maxRps: 40, durationSec: 5 },
    ];
    expect(() =>
      createCampaign({ ...base, agent: 'k6', scenario }, hosts, agentChoices()),
    ).not.toThrow();
  });
});
