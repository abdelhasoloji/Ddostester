import { describe, it, expect } from 'vitest';
import { niceTicks, pathFor } from './live-chart.js';

describe('niceTicks', () => {
  it('covers the data max with round steps starting at 0', () => {
    const t = niceTicks(92);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(92); // domain top covers the data
    // Steps are uniform + round.
    const step = t[1] - t[0];
    expect(step).toBeGreaterThan(0);
    t.forEach((v, i) => expect(v).toBeCloseTo(i * step, 6));
  });

  it('handles small and degenerate maxima', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(-5)).toEqual([0, 1]);
    expect(niceTicks(NaN)).toEqual([0, 1]);
    const t = niceTicks(1);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(1);
  });
});

describe('pathFor', () => {
  const sx = (x: number) => x * 10;
  const sy = (y: number) => 100 - y;

  it('draws a moveTo then lineTos through the points', () => {
    const d = pathFor(
      [
        [0, 0],
        [1, 5],
        [2, 10],
      ],
      sx,
      sy,
    );
    expect(d.startsWith('M0.0 100.0')).toBe(true);
    expect(d).toContain('L10.0 95.0');
    expect(d).toContain('L20.0 90.0');
  });

  it('breaks the line across a null gap (no stroke back to zero)', () => {
    const d = pathFor(
      [
        [0, 5],
        [1, null],
        [2, 8],
      ],
      sx,
      sy,
    );
    // Two separate subpaths → two moveTo commands, no line spanning the gap.
    expect((d.match(/M/g) ?? []).length).toBe(2);
  });

  it('is empty when there is nothing finite to draw', () => {
    expect(pathFor([[0, null]], sx, sy)).toBe('');
  });
});
