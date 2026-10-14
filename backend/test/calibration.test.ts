import { describe, expect, it } from 'vitest';
import {
  calibratedRate,
  scaleScenario,
  peakRps,
  scenarioMeanRps,
  CALIBRATION_KEEP_THRESHOLD,
  CALIBRATION_SAFETY,
} from '../src/modules/campaigns/calibration.js';

describe('calibratedRate (closed-loop rate calibration, GEN-1)', () => {
  it('keeps the requested rate when the burst delivered ≥ keep threshold', () => {
    // 760/800 = 95% ≥ 90% → no need to calibrate down.
    const r = calibratedRate(800, 760);
    expect(r.calibrated).toBe(false);
    expect(r.appliedRps).toBe(800);
    expect(r.requestedRps).toBe(800);
    expect(r.deliveredRps).toBe(760);
  });

  it('lowers the graded rate to the deliverable ceiling when under-delivering', () => {
    // The THOR case: requested 1000, a burst delivered ~650 → grade at 650×safety.
    const r = calibratedRate(1000, 650);
    expect(r.calibrated).toBe(true);
    expect(r.appliedRps).toBe(Math.floor(650 * CALIBRATION_SAFETY));
    expect(r.appliedRps).toBeLessThan(1000);
    expect(r.appliedRps).toBeGreaterThan(0);
  });

  it('the 17% composite case is calibrated far down', () => {
    // MultiVector: requested 800, a built-in-pinned burst delivered ~135.
    const r = calibratedRate(800, 135);
    expect(r.calibrated).toBe(true);
    expect(r.appliedRps).toBe(Math.floor(135 * CALIBRATION_SAFETY));
  });

  it('never raises the rate above the requested one, even if the burst over-reads', () => {
    const r = calibratedRate(400, 999);
    expect(r.appliedRps).toBe(400); // clamped to requested
    expect(r.calibrated).toBe(false);
  });

  it('keeps the requested rate when the burst produced nothing (no signal)', () => {
    // A failed/empty calibration must never make the line offer zero.
    const r = calibratedRate(500, 0);
    expect(r.calibrated).toBe(false);
    expect(r.appliedRps).toBe(500);
  });

  it('applied is always positive and ≤ requested', () => {
    for (const [req, del] of [
      [800, 1],
      [1000, 650],
      [50, 3],
      [200, 200],
    ] as const) {
      const r = calibratedRate(req, del);
      expect(r.appliedRps).toBeGreaterThan(0);
      expect(r.appliedRps).toBeLessThanOrEqual(req);
    }
  });

  it('preserves fractional requests and lowers measured sub-one delivery', () => {
    expect(calibratedRate(0.5, 0).appliedRps).toBe(0.5);
    expect(calibratedRate(0.5, 0.5).appliedRps).toBe(0.5);
    expect(calibratedRate(0.5, 0.2).appliedRps).toBeCloseTo(0.19);
    expect(calibratedRate(1, 0.2).appliedRps).toBeCloseTo(0.19);
    expect(calibratedRate(1.5, 0).requestedRps).toBe(1.5);
    expect(() => calibratedRate(Infinity, 1)).toThrow('Invalid');
    expect(calibratedRate(0.5, NaN).appliedRps).toBe(0.5);
  });

  it('the keep threshold is the documented 0.9', () => {
    expect(CALIBRATION_KEEP_THRESHOLD).toBe(0.9);
    // Just below threshold calibrates; at/above keeps.
    expect(calibratedRate(1000, 899).calibrated).toBe(true);
    expect(calibratedRate(1000, 900).calibrated).toBe(false);
  });
});

describe('scaleScenario (preserve shape at a deliverable amplitude)', () => {
  it('scales every phase rate by the factor, preserving the relative shape', () => {
    const phases = [
      { maxRps: 200, durationSec: 30 },
      { maxRps: 1000, durationSec: 60 }, // the pulse peak
      { maxRps: 400, durationSec: 30 },
    ];
    const scaled = scaleScenario(phases, 0.65);
    expect(scaled.map((p) => p.maxRps)).toEqual([130, 650, 260]);
    // Durations (the shape's time axis) are untouched.
    expect(scaled.map((p) => p.durationSec)).toEqual([30, 60, 30]);
    // The relative shape (ratios) is preserved.
    expect(scaled[1].maxRps / scaled[0].maxRps).toBeCloseTo(1000 / 200, 5);
  });

  it('preserves fractional phases and never raises them above the original', () => {
    const scaled = scaleScenario([{ maxRps: 3, durationSec: 10 }], 0.05);
    expect(scaled[0].maxRps).toBeCloseTo(0.15);
    expect(scaleScenario([{ maxRps: 0.5, durationSec: 10 }], 0.4)[0].maxRps).toBeCloseTo(0.2);
    expect(() => scaleScenario([{ maxRps: 0.5, durationSec: 10 }], NaN)).toThrow('Invalid');
    const noUp = scaleScenario([{ maxRps: 100, durationSec: 10 }], 1);
    expect(noUp[0].maxRps).toBe(100);
    const clamped = scaleScenario([{ maxRps: 100, durationSec: 10 }], 5);
    expect(clamped[0].maxRps).toBe(100); // factor clamped to [0,1]
  });
});

describe('peakRps', () => {
  it('returns the max phase rate when phased, else the flat maxRps', () => {
    expect(peakRps(400)).toBe(400);
    expect(
      peakRps(400, [
        { maxRps: 200, durationSec: 10 },
        { maxRps: 800, durationSec: 10 },
      ]),
    ).toBe(800);
    expect(peakRps(400, [])).toBe(400);
  });
});

describe('scenarioMeanRps (delivery denominator: the intended mean, not the peak)', () => {
  it('equals maxRps for a constant profile (no phases)', () => {
    expect(scenarioMeanRps(500)).toBe(500);
    expect(scenarioMeanRps(500, [])).toBe(500);
  });

  it('is ~73% of the peak for the wave shape (100/20/100 %)', () => {
    // buildScenario('wave', 800, T) → phases at 800, 160, 800 of equal duration.
    const wave = [
      { maxRps: 800, durationSec: 60 },
      { maxRps: 160, durationSec: 60 },
      { maxRps: 800, durationSec: 60 },
    ];
    expect(scenarioMeanRps(800, wave)).toBeCloseTo((800 + 160 + 800) / 3, 5);
    expect(scenarioMeanRps(800, wave) / 800).toBeCloseTo(0.7333, 3);
  });

  it('is ~58% of the peak for the ramp shape (25/50/100 %) — which would falsely fail at the peak', () => {
    const ramp = [
      { maxRps: 250, durationSec: 40 },
      { maxRps: 500, durationSec: 40 },
      { maxRps: 1000, durationSec: 40 },
    ];
    expect(scenarioMeanRps(1000, ramp) / 1000).toBeCloseTo(0.5833, 3);
  });

  it('time-weights phases of unequal duration', () => {
    const phases = [
      { maxRps: 1000, durationSec: 90 },
      { maxRps: 100, durationSec: 10 },
    ];
    // (1000×90 + 100×10) / 100 = 910
    expect(scenarioMeanRps(1000, phases)).toBe(910);
  });
});
