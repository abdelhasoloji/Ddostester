import { describe, it, expect, afterEach } from 'vitest';
import { HARD_CAPS } from '../src/config/limits.js';
import { serviceCeiling } from '../src/config/service-ceiling.js';

afterEach(() => {
  delete process.env.SERVICE_CEILING_RPS;
  delete process.env.SERVICE_CEILING_CONCURRENCY;
  delete process.env.SERVICE_CEILING_DURATION;
  delete process.env.SERVICE_CEILING_AGENTS;
});

describe('service ceiling', () => {
  it('defaults to the immutable hard cap and never exceeds it', () => {
    const c = serviceCeiling({});
    expect(c.maxRps).toBe(HARD_CAPS.maxRps);
    expect(c.maxConcurrency).toBe(HARD_CAPS.maxConcurrency);
    expect(c.maxDurationSec).toBe(HARD_CAPS.maxDurationSec);
    expect(c.maxAgents).toBeGreaterThan(0);
  });

  it('honours an operator override below the hard cap', () => {
    const c = serviceCeiling({ SERVICE_CEILING_RPS: '1500', SERVICE_CEILING_AGENTS: '12' });
    expect(c.maxRps).toBe(1500);
    expect(c.maxAgents).toBe(12);
  });

  it('clamps an override above the immutable cap', () => {
    const c = serviceCeiling({
      SERVICE_CEILING_RPS: '999999',
      SERVICE_CEILING_CONCURRENCY: '9999',
    });
    expect(c.maxRps).toBe(HARD_CAPS.maxRps);
    expect(c.maxConcurrency).toBe(HARD_CAPS.maxConcurrency);
  });

  it('ignores a non-numeric override', () => {
    const c = serviceCeiling({ SERVICE_CEILING_RPS: 'lots' });
    expect(c.maxRps).toBe(HARD_CAPS.maxRps);
  });
});
