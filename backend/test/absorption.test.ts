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
});
