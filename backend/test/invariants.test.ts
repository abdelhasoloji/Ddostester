import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeWrs,
  wrsLevel,
  detectionScore,
  mitigationScore,
  availabilityScore,
  collateralScore,
} from '../src/modules/wrs/scoring.js';
import { buildEndpointPicker, iterationRate } from '../src/engine/loadTest.js';
import { buildK6Script } from '../src/agents/k6.js';

const num = fc.double({ min: -1e6, max: 1e6, noNaN: true });

describe('WRS invariants', () => {
  it('every component score stays within [0,100] for any input', () => {
    fc.assert(
      fc.property(num, (n) => {
        for (const s of [detectionScore(n), mitigationScore(n), collateralScore(n)]) {
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(100);
        }
      }),
    );
  });

  it('availabilityScore is in [0,100] and 0 when total <= 0', () => {
    fc.assert(
      fc.property(fc.nat(1_000_000), fc.nat(1_000_000), (a, b) => {
        const total = a + b;
        const s = availabilityScore(a, total);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(100);
      }),
    );
    expect(availabilityScore(5, 0)).toBe(0);
  });

  it('the aggregate WRS is always in [0,100] and its level matches the score', () => {
    fc.assert(
      fc.property(num, num, fc.nat(100000), fc.nat(100000), num, (det, mit, succ, extra, adj) => {
        const w = computeWrs({
          detectionTimeSec: det,
          mitigationTimeSec: mit,
          legitimateSuccessful: succ,
          legitimateTotal: succ + extra,
          adjacentImpactScore: adj,
        });
        expect(w.wrs).toBeGreaterThanOrEqual(0);
        expect(w.wrs).toBeLessThanOrEqual(100);
        expect(w.level).toBe(wrsLevel(w.wrs));
      }),
    );
  });

  it('faster detection/mitigation never lowers the score', () => {
    fc.assert(
      fc.property(fc.nat(600), fc.nat(600), (fast, slower) => {
        const slow = fast + slower;
        expect(detectionScore(fast)).toBeGreaterThanOrEqual(detectionScore(slow));
        expect(mitigationScore(fast)).toBeGreaterThanOrEqual(mitigationScore(slow));
      }),
    );
  });
});

describe('engine rate invariants', () => {
  it('k6 integer arrivals preserve request caps across short flows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 20 }),
        (rps, steps) => {
          const script = buildK6Script({
            url: 'http://127.0.0.1/health',
            concurrency: 2,
            durationSec: 3,
            maxRps: rps,
            authorized: true,
            flow: Array.from({ length: steps }, () => ({
              method: 'GET' as const,
              url: 'http://127.0.0.1/health',
            })),
          });
          const rate = Number(/\n\s+rate: ([0-9]+)/.exec(script)![1]);
          const period = Number(/timeUnit: '([0-9]+)s'/.exec(script)![1]);
          expect(rate).toBeGreaterThanOrEqual(1);
          expect((rate * steps) / period).toBeLessThanOrEqual(rps);
        },
      ),
    );
  });

  it('integer iterationRate never raises the total request budget', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 1, max: 20 }), (rps, n) => {
        const r = iterationRate(rps, n);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r * n).toBeLessThanOrEqual(rps);
      }),
    );
  });

  it('the endpoint picker always returns a configured endpoint', () => {
    const eps = [
      { url: 'http://h/a', weight: 2 },
      { url: 'http://h/b', weight: 0 },
      { url: 'http://h/c', weight: 1 },
    ];
    const pick = buildEndpointPicker(eps);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.999999, noNaN: true }), (r) => {
        expect(eps).toContain(pick(r));
      }),
    );
    // A zero-weight endpoint is never selected.
    const picks = Array.from({ length: 500 }, (_, i) => pick(i / 500));
    expect(picks.some((p) => p.url === 'http://h/b')).toBe(false);
  });
});
