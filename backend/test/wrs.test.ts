import { describe, it, expect } from 'vitest';
import { computeWrs, wrsLevel, detectionScore } from '../src/modules/wrs/scoring.js';

describe('WRS scoring', () => {
  it('score parfait quand tout est optimal', () => {
    const r = computeWrs({
      detectionTimeSec: 0,
      mitigationTimeSec: 0,
      legitimateSuccessful: 100,
      legitimateTotal: 100,
      adjacentImpactScore: 0,
    });
    expect(r.wrs).toBe(100);
    expect(r.level).toBe('A+');
  });

  it('exemples du TSD §5.4', () => {
    expect(detectionScore(10)).toBe(95);
    const r = computeWrs({
      detectionTimeSec: 10,
      mitigationTimeSec: 30,
      legitimateSuccessful: 995,
      legitimateTotal: 1000,
      adjacentImpactScore: 0,
    });
    // D=95, M=90, A=99.5, C=100
    expect(r.detection).toBe(95);
    expect(r.mitigation).toBe(90);
    expect(r.availability).toBe(99.5);
    expect(r.wrs).toBeCloseTo(95.85, 2);
    expect(r.level).toBe('A+');
  });

  it('borne les scores dans [0,100]', () => {
    const r = computeWrs({
      detectionTimeSec: 10_000,
      mitigationTimeSec: 10_000,
      legitimateSuccessful: 0,
      legitimateTotal: 100,
      adjacentImpactScore: 200,
    });
    expect(r.wrs).toBe(0);
    expect(r.level).toBe('F');
  });

  it('mappe les niveaux', () => {
    expect(wrsLevel(90)).toBe('A');
    expect(wrsLevel(75)).toBe('B');
    expect(wrsLevel(55)).toBe('C');
    expect(wrsLevel(40)).toBe('D');
    expect(wrsLevel(10)).toBe('F');
  });
});
