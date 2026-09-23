import { describe, it, expect } from 'vitest';
import { validateMitigation, type RunSampleLike } from '../src/modules/mitigation/validation.js';

// A run where the edge absorbs hard and the probe recovers after mitigation.
const MITIGATED: RunSampleLike[] = [
  { t: 1, sent: 100, failed: 5, availPct: 90 },
  { t: 2, sent: 200, failed: 12, availPct: 80 },
  { t: 3, sent: 300, failed: 25, availPct: 70 },
  { t: 4, sent: 400, failed: 60, availPct: 75 },
  { t: 5, sent: 500, failed: 140, availPct: 88 },
  { t: 6, sent: 600, failed: 240, availPct: 93 },
  { t: 7, sent: 700, failed: 340, availPct: 96 },
  { t: 8, sent: 800, failed: 440, availPct: 97 },
];

describe('validateMitigation', () => {
  it('flags a run with no measured timing', () => {
    const v = validateMitigation({ timeline: MITIGATED });
    expect(v.verdict).toBe('no-measurement');
    expect(v.ttdSec).toBeUndefined();
  });

  it('flags a too-short timeline', () => {
    const v = validateMitigation({
      timeline: MITIGATED.slice(0, 2),
      protection: { detectionTimeSec: 3, mitigationTimeSec: 5 },
    });
    expect(v.verdict).toBe('insufficient-data');
  });

  it('flags mitigation that never engaged (TTM = 0)', () => {
    const v = validateMitigation({
      timeline: MITIGATED,
      protection: { detectionTimeSec: 3, mitigationTimeSec: 0, source: 'wedos-lab-scrubber' },
    });
    expect(v.verdict).toBe('not-engaged');
    expect(v.ttdSec).toBe(3);
  });

  it('validates a mitigated run: absorption up, availability up, WRS delta positive', () => {
    const v = validateMitigation({
      timeline: MITIGATED,
      protection: { detectionTimeSec: 3, mitigationTimeSec: 5, source: 'wedos-lab-scrubber' },
    });
    expect(v.verdict).toBe('mitigated');
    expect(v.source).toBe('wedos-lab-scrubber');
    expect(v.ttdSec).toBe(3);
    expect(v.ttmSec).toBe(5);
    // Before window [0,3): only the pre-detection samples.
    expect(v.before?.absorbedRatio).toBeLessThan(0.2);
    // After window [5,·): the edge is dropping most offered traffic.
    expect(v.after!.absorbedRatio).toBeGreaterThan(0.8);
    expect(v.absorbedDelta!).toBeGreaterThan(0);
    expect(v.availabilityDelta!).toBeGreaterThan(0);
    expect(v.wrsDelta!).toBeGreaterThan(0);
    expect(v.note).toMatch(/absorption/);
  });

  it('reports partial when the target does not recover after mitigation', () => {
    const noRecover = MITIGATED.map((s) => (s.t >= 5 ? { ...s, availPct: 55 } : s));
    const v = validateMitigation({
      timeline: noRecover,
      protection: { detectionTimeSec: 3, mitigationTimeSec: 5 },
    });
    expect(v.verdict).toBe('partial');
    expect(v.availabilityDelta!).toBeLessThan(0);
  });

  it('flags insufficient data when the mitigation window falls outside the run', () => {
    const v = validateMitigation({
      timeline: MITIGATED,
      protection: { detectionTimeSec: 3, mitigationTimeSec: 999 },
    });
    expect(v.verdict).toBe('insufficient-data');
  });
});
