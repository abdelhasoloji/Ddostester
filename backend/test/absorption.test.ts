import { describe, it, expect } from 'vitest';
import { computeAbsorption, splitFailures } from '../src/modules/reports/absorption.js';

describe('splitFailures (edge mechanism: reject vs tarpit)', () => {
  it('classifies 0xx transport failures as TARPIT, not rejected (the Capacity-ceiling bug)', () => {
    // A cache-busted GET that tarpits the origin to 10s timeouts.
    const s = splitFailures({ '0xx': 77309, '2xx': 18660 });
    expect(s.tarpitted).toBe(77309); // held to timeout — a tarpit
    expect(s.rejected).toBe(0); // NOT a 4xx/5xx rejection
  });

  it('classifies 4xx/5xx as rejected (the edge answered a refusal)', () => {
    const s = splitFailures({ '2xx': 100, '4xx': 300, '5xx': 50 });
    expect(s.rejected).toBe(350);
    expect(s.tarpitted).toBe(0);
  });

  it('treats an "err" bucket as tarpit too, and falls back to the errors map', () => {
    expect(splitFailures({ err: 40, '2xx': 10 }).tarpitted).toBe(40);
    // No transport status bucket → fall back to the errors map count.
    expect(splitFailures({ '2xx': 10 }, { timeout: 12, reset: 3 }).tarpitted).toBe(15);
  });

  it('mixes both mechanisms correctly', () => {
    const s = splitFailures({ '2xx': 200, '4xx': 100, '0xx': 500 });
    expect(s.rejected).toBe(100); // 4xx
    expect(s.tarpitted).toBe(500); // 0xx
  });
});

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

  it('measures shortfall against the EXPECTED mean rate, not the peak (wave/ramp)', () => {
    // A faithfully-delivered wave: peak 800, its scenario mean is ~586 (73% of
    // peak), and it delivered 570 — that is NOT a shortfall, it's the wave shape.
    const a = computeAbsorption({
      configuredRps: 800, // peak (for display)
      expectedRps: 586, // intended mean over the wave
      achievedRps: 570,
      totalRequests: 100000,
      successful: 100000,
      failed: 0,
      durationSec: 180,
    });
    expect(a.configuredRps).toBe(800); // peak still reported for display
    expect(a.expectedRps).toBe(586);
    // 1 - 570/586 ≈ 0.027 — essentially delivered, not the false 1-570/800 = 0.29.
    expect(a.offeredShortfall).toBeCloseTo(1 - 570 / 586, 5);
    expect(a.offeredShortfall).toBeLessThan(0.05);
  });

  it('defaults expectedRps to configuredRps for a constant profile', () => {
    const a = computeAbsorption({
      configuredRps: 400,
      achievedRps: 400,
      totalRequests: 1000,
      successful: 1000,
      failed: 0,
      durationSec: 10,
    });
    expect(a.expectedRps).toBe(400);
    expect(a.offeredShortfall).toBe(0);
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
