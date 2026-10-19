import { describe, it, expect } from 'vitest';
import {
  highRateEngineUpgrade,
  builtinUnderDeliveryReason,
} from '../src/modules/campaigns/engine-route.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

const CEIL = 150;
const CONC = 300;
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

  it('routes a CORRELATION flow to k6 too (k6 is now correlation-capable, P6)', () => {
    const flow = [
      {
        method: 'POST' as const,
        url: 'https://t/login',
        extract: { name: 'tok', from: 'json' as const, expr: '$.token' },
      },
      { method: 'GET' as const, url: 'https://t/me' },
    ];
    expect(highRateEngineUpgrade(base({ flow }), CEIL)).toBe('k6');
  });

  it('routes a high-rate recon-seeded endpoint mix to vegeta (now endpoint-capable)', () => {
    expect(
      highRateEngineUpgrade(
        base({ endpoints: [{ url: 'https://t/a' }, { url: 'https://t/b' }] }),
        CEIL,
      ),
    ).toBe('vegeta');
  });

  it('keeps built-in for data-feeder / assertion (the only remaining built-in-only features)', () => {
    expect(highRateEngineUpgrade(base({ dataset: [{ k: 'v' }] }), CEIL)).toBeNull();
    expect(
      highRateEngineUpgrade(base({ assertion: { status: 200 } } as Partial<Campaign>), CEIL),
    ).toBeNull();
  });

  it('routes a UA-rotation flood to vegeta (vegeta now spreads UAs across its targets file)', () => {
    // Regression for the DRS5 composite lines: UA rotation used to pin them to
    // the ~150-rps built-in engine → 17% delivery of an 800-rps configured rate.
    expect(highRateEngineUpgrade(base({ userAgents: ['x', 'y'] }), CEIL)).toBe('vegeta');
    // Combined with an endpoint mix (exactly the composite shape) → still vegeta.
    expect(
      highRateEngineUpgrade(
        base({
          userAgents: ['x', 'y'],
          endpoints: [{ url: 'https://t/a' }, { url: 'https://t/b' }],
        }),
        CEIL,
      ),
    ).toBe('vegeta');
  });

  it('routes a LOW-rate but HIGH-concurrency flood off the loop (event-loop safety)', () => {
    // At/below both ceilings → keep built-in.
    expect(highRateEngineUpgrade(base({ maxRps: 100, concurrency: 300 }), CEIL, CONC)).toBeNull();
    // Rate is fine but concurrency saturates the in-process loop → route to vegeta.
    expect(highRateEngineUpgrade(base({ maxRps: 100, concurrency: 400 }), CEIL, CONC)).toBe(
      'vegeta',
    );
  });

  it('does not route high concurrency when the concurrency ceiling is not supplied', () => {
    // Back-compat: a 2-arg call keeps the rate-only behaviour (ceiling = ∞).
    expect(highRateEngineUpgrade(base({ maxRps: 100, concurrency: 999 }), CEIL)).toBeNull();
  });

  it('still respects built-in-only features even when concurrency is high', () => {
    // A high-concurrency data-feeder flood can't route (only built-in feeds data).
    expect(
      highRateEngineUpgrade(
        base({ maxRps: 100, concurrency: 400, dataset: [{ k: 'v' }] }),
        CEIL,
        CONC,
      ),
    ).toBeNull();
  });

  it('NEVER routes a slowloris off the built-in engine (it is the only one that holds slow connections)', () => {
    // High concurrency would otherwise trigger a route to vegeta — but vegeta can't
    // do slowloris, so routing would silently turn it into an ordinary flood.
    expect(
      highRateEngineUpgrade(
        base({ vector: 'http-slowloris', maxRps: 100, concurrency: 500 }),
        CEIL,
        CONC,
      ),
    ).toBeNull();
    // High rate must not route it either.
    expect(
      highRateEngineUpgrade(base({ vector: 'http-slowloris', maxRps: 800, concurrency: 50 }), CEIL),
    ).toBeNull();
    // Sanity: the same shape WITHOUT the slowloris vector still routes (proves the
    // guard is what keeps it built-in, not some other condition).
    expect(
      highRateEngineUpgrade(
        base({ vector: 'http-get', maxRps: 100, concurrency: 500 }),
        CEIL,
        CONC,
      ),
    ).toBe('vegeta');
  });
});

describe('builtinUnderDeliveryReason (refuse, never silently under-deliver)', () => {
  const guards = (over: { maxRps: number; concurrency: number; calibrate?: boolean }) =>
    builtinUnderDeliveryReason(over, 'builtin-http', CEIL, CONC);

  it('allows a built-in run at or below its measured ceiling', () => {
    expect(guards({ maxRps: 150, concurrency: 300 })).toBeNull();
    expect(guards({ maxRps: 20, concurrency: 5 })).toBeNull();
  });

  it('refuses a built-in run above the rate ceiling', () => {
    expect(guards({ maxRps: 151, concurrency: 10 })).toContain('would silently under-deliver');
  });

  it('refuses a built-in run above the concurrency ceiling', () => {
    expect(guards({ maxRps: 100, concurrency: 301 })).toContain('would silently under-deliver');
  });

  it('accepts an over-ceiling run that opted into calibration', () => {
    expect(guards({ maxRps: 800, concurrency: 200, calibrate: true })).toBeNull();
  });

  it('never blocks an out-of-process or fleet engine', () => {
    for (const engine of ['vegeta', 'k6', 'kubernetes-fleet', 'locust'])
      expect(
        builtinUnderDeliveryReason({ maxRps: 800, concurrency: 200 }, engine, CEIL, CONC),
      ).toBeNull();
  });
});
