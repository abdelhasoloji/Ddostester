import { describe, it, expect } from 'vitest';
import type { RunSample } from './api.js';
import { theaterPanels } from './ui.js';

const sample = (over: Partial<RunSample>): RunSample => ({
  t: 0,
  rps: 0,
  sent: 0,
  failed: 0,
  probe5xx: 0,
  availPct: 100,
  ...over,
});

describe('theaterPanels (Run Theater charts from the live timeline)', () => {
  it('builds three panels with the right labels, units and series', () => {
    const panels = theaterPanels([
      sample({ t: 1, rps: 100, sent: 100, failed: 0, availPct: 100 }),
      sample({ t: 2, rps: 200, sent: 400, failed: 200, availPct: 80 }),
    ]);
    expect(panels.map((p) => p.label)).toEqual([
      'Offered vs reached-origin RPS',
      'Absorbed by edge (%)',
      'Legitimate availability (%)',
    ]);
    // RPS panel anchors at zero; the percent panels are fixed to [0,100].
    expect(panels[0].yFromZero).toBe(true);
    expect(panels[1].yRange).toEqual([0, 100]);
    expect(panels[2].yRange).toEqual([0, 100]);
  });

  it('reached-origin RPS = offered × success ratio (from cumulative sent/failed)', () => {
    const [rps] = theaterPanels([
      sample({ t: 1, rps: 100, sent: 100, failed: 0 }), // 0% absorbed → origin = offered
      sample({ t: 2, rps: 800, sent: 1000, failed: 990 }), // 99% absorbed → origin ≈ 8
    ]);
    const offered = rps.series[0].points;
    const origin = rps.series[1].points;
    expect(offered).toEqual([
      [1, 100],
      [2, 800],
    ]);
    expect(origin[0]).toEqual([1, 100]); // nothing absorbed yet
    expect(origin[1][0]).toBe(2);
    expect(origin[1][1]).toBeCloseTo(800 * (10 / 1000), 5); // 8 rps reaches origin
  });

  it('absorbed % = failed/sent (matches the tiles) and availability tracks availPct', () => {
    const panels = theaterPanels([
      sample({ t: 1, rps: 500, sent: 1000, failed: 999, availPct: 40 }),
    ]);
    const absorbed = panels[1].series[0].points;
    const avail = panels[2].series[0].points;
    expect(absorbed[0][1]).toBeCloseTo(99.9, 5);
    expect(avail[0]).toEqual([1, 40]);
  });

  it('is zero-safe before any request has been sent', () => {
    const panels = theaterPanels([sample({ t: 0, rps: 0, sent: 0, failed: 0, availPct: 100 })]);
    expect(panels[0].series[1].points[0]).toEqual([0, 0]); // origin rps = 0
    expect(panels[1].series[0].points[0]).toEqual([0, 0]); // absorbed % = 0, not NaN
    expect(panels[2].series[0].points[0]).toEqual([0, 100]);
  });
});
