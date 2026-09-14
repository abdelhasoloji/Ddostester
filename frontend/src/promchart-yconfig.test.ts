import { describe, expect, it } from 'vitest';
import { yConfigForUnit } from './PromChart.js';

describe('yConfigForUnit', () => {
  it('pins a percent panel to [0,100] (availability/absorption never runs to 200%)', () => {
    expect(yConfigForUnit('percent')).toEqual({ yRange: [0, 100], yFromZero: false });
  });
  it('anchors a rate/latency panel at 0 and fits its max (a 349 rps line is never clipped)', () => {
    expect(yConfigForUnit('reqps')).toEqual({ yFromZero: true });
    expect(yConfigForUnit('ms')).toEqual({ yFromZero: true });
  });
  it('leaves anything else on uPlot auto-range', () => {
    expect(yConfigForUnit('short')).toEqual({ yFromZero: false });
  });
});
