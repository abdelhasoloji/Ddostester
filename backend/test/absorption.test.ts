import { describe, it, expect } from 'vitest';
import { computeAbsorption } from '../src/modules/reports/absorption.js';

describe('computeAbsorption', () => {
  it('computes origin RPS and absorbed ratio from generator stats', () => {
    const a = computeAbsorption({
      configuredRps: 100,
      achievedRps: 80,
      totalRequests: 1000,
      successful: 600,
      failed: 400,
      durationSec: 100,
    });
    expect(a.configuredRps).toBe(100);
    expect(a.achievedRps).toBe(80);
    expect(a.originRps).toBeCloseTo(6, 5); // 600 / 100s
    expect(a.absorbedRatio).toBeCloseTo(0.4, 5); // 400 / 1000
    expect(a.absorbedPct).toBe(40);
  });

  it('is zero-safe when nothing was sent', () => {
    const a = computeAbsorption({
      configuredRps: 50,
      achievedRps: 0,
      totalRequests: 0,
      successful: 0,
      failed: 0,
      durationSec: 0,
    });
    expect(a.originRps).toBe(0);
    expect(a.absorbedRatio).toBe(0);
    expect(a.absorbedPct).toBe(0);
  });

  it('reports full absorption when the edge rejected everything', () => {
    const a = computeAbsorption({
      configuredRps: 200,
      achievedRps: 200,
      totalRequests: 500,
      successful: 0,
      failed: 500,
      durationSec: 10,
    });
    expect(a.originRps).toBe(0);
    expect(a.absorbedPct).toBe(100);
  });

  it('breaks absorption into reject vs tarpit, and captures offered shortfall', () => {
    // Configured 300 but only sustained 120 (backpressure); of 1000 attempts,
    // 200 got 4xx (rejected) and 600 timed out (tarpitted).
    const a = computeAbsorption({
      configuredRps: 300,
      achievedRps: 120,
      totalRequests: 1000,
      successful: 200,
      failed: 800,
      durationSec: 50,
      rejected: 200,
      tarpitted: 600,
    });
    expect(a.rejectedRatio).toBeCloseTo(0.2, 5);
    expect(a.tarpitRatio).toBeCloseTo(0.6, 5);
    expect(a.offeredShortfall).toBeCloseTo(0.6, 5); // 1 - 120/300
  });

  it('clamps offered shortfall to [0,1] when achieved exceeds configured', () => {
    const a = computeAbsorption({
      configuredRps: 100,
      achievedRps: 130,
      totalRequests: 10,
      successful: 10,
      failed: 0,
      durationSec: 1,
    });
    expect(a.offeredShortfall).toBe(0);
    expect(a.rejectedRatio).toBe(0);
    expect(a.tarpitRatio).toBe(0);
  });
});
