import { describe, it, expect } from 'vitest';
import { highRateEngineUpgrade } from '../src/modules/campaigns/engine-route.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

const CEIL = 150;
const base = (over: Partial<Campaign>): Parameters<typeof highRateEngineUpgrade>[0] =>
  ({ maxRps: 400, ...over }) as Campaign;

describe('highRateEngineUpgrade (measurement-fidelity routing)', () => {
  it('keeps built-in at or below the ceiling', () => {
    expect(highRateEngineUpgrade(base({ maxRps: 150 }), CEIL)).toBeNull();
    expect(highRateEngineUpgrade(base({ maxRps: 100 }), CEIL)).toBeNull();
  });

  it('routes a simple high-rate flood (GET or POST) to vegeta', () => {
    expect(highRateEngineUpgrade(base({ maxRps: 400 }), CEIL)).toBe('vegeta');
    expect(highRateEngineUpgrade(base({ maxRps: 800 }), CEIL)).toBe('vegeta');
  });

  it('routes a phased flood to vegeta (multi-phase capable)', () => {
    expect(
      highRateEngineUpgrade(
        base({ scenario: [{ maxRps: 400, durationSec: 30 }] } as Partial<Campaign>),
        CEIL,
      ),
    ).toBe('vegeta');
  });

  it('routes a request flow (no correlation) to k6', () => {
    const flow = [{ method: 'GET' as const, url: 'https://t/' }];
    expect(highRateEngineUpgrade(base({ flow }), CEIL)).toBe('k6');
  });

  it('keeps built-in for a correlation flow (only built-in supports it)', () => {
    const flow = [
      {
        method: 'POST' as const,
        url: 'https://t/login',
        extract: { name: 'tok', from: 'json' as const, expr: '$.token' },
      },
      { method: 'GET' as const, url: 'https://t/me' },
    ];
    expect(highRateEngineUpgrade(base({ flow }), CEIL)).toBeNull();
  });

  it('routes a high-rate recon-seeded endpoint mix to vegeta (now endpoint-capable)', () => {
    expect(
      highRateEngineUpgrade(
        base({ endpoints: [{ url: 'https://t/a' }, { url: 'https://t/b' }] }),
        CEIL,
      ),
    ).toBe('vegeta');
  });

  it('keeps built-in for data-feeder / assertion / UA rotation (built-in-only features)', () => {
    expect(highRateEngineUpgrade(base({ dataset: [{ k: 'v' }] }), CEIL)).toBeNull();
    expect(
      highRateEngineUpgrade(base({ assertion: { status: 200 } } as Partial<Campaign>), CEIL),
    ).toBeNull();
    expect(highRateEngineUpgrade(base({ userAgents: ['x', 'y'] }), CEIL)).toBeNull();
  });
});
