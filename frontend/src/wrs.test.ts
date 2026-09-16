import { describe, expect, it } from 'vitest';
import { WRS_BANDS, gradeFromScore, wrsRange, wrsClass } from './wrs.js';

describe('gradeFromScore', () => {
  it('maps scores to letter bands at the documented boundaries', () => {
    const cases: [number, string][] = [
      [100, 'A+'],
      [90, 'A+'],
      [89, 'A'],
      [80, 'A'],
      [79, 'B'],
      [70, 'B'],
      [69, 'C'],
      [55, 'C'],
      [54, 'D'],
      [40, 'D'],
      [39, 'F'],
      [0, 'F'],
    ];
    for (const [score, level] of cases) expect(gradeFromScore(score)).toBe(level);
  });
});

describe('wrsRange', () => {
  it('derives the display range from the bands (no hardcoded strings)', () => {
    expect(wrsRange('A+')).toBe('90–100');
    expect(wrsRange('A')).toBe('80–89');
    expect(wrsRange('B')).toBe('70–79');
    expect(wrsRange('C')).toBe('55–69');
    expect(wrsRange('D')).toBe('40–54');
    expect(wrsRange('F')).toBe('0–39');
  });
});

describe('WRS single source of truth', () => {
  it('the legend range for a band always contains that band, and the pill agrees', () => {
    for (const b of WRS_BANDS) {
      // The band's lower bound grades to the band itself (pill ↔ legend agree).
      expect(gradeFromScore(b.min)).toBe(b.level);
      const [lo, hi] = wrsRange(b.level).split('–').map(Number);
      expect(lo).toBe(b.min);
      expect(hi).toBeGreaterThanOrEqual(lo);
      // Every score inside the displayed range grades to this band.
      expect(gradeFromScore(lo)).toBe(b.level);
      expect(gradeFromScore(hi)).toBe(b.level);
    }
  });
});

describe('wrsClass', () => {
  it('escapes the + so the CSS class is valid', () => {
    expect(wrsClass('A+')).toBe('wrs-Ap');
    expect(wrsClass('B')).toBe('wrs-B');
    expect(wrsClass('F')).toBe('wrs-F');
  });
});
