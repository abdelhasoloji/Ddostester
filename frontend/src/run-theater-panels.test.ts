import { describe, it, expect } from 'vitest';
import type { RunSample } from './api.js';
import { theaterPanels, hasLiveGenerator, panelsXMax } from './ui.js';

const sample = (over: Partial<RunSample>): RunSample => ({
  t: 0,
  rps: 0,
  sent: 0,
  failed: 0,
  probe5xx: 0,
  availPct: 100,
  successful: Math.max(0, (over.sent ?? 0) - (over.failed ?? 0)),
  ...over,
});

describe('hasLiveGenerator (does the engine stream live generator counts?)', () => {
  it('true once any sample has offered/sent > 0 (built-in engine)', () => {
    expect(hasLiveGenerator([sample({ t: 1, rps: 50, sent: 50 })])).toBe(true);
  });
  it('false when every sample is zero (external engine: k6/vegeta/locust)', () => {
    expect(
      hasLiveGenerator([
        sample({ t: 1, rps: 0, sent: 0, availPct: 100, probeP95: 40 }),
        sample({ t: 2, rps: 0, sent: 0, availPct: 100, probeP95: 42 }),
      ]),
    ).toBe(false);
  });
});

describe('theaterPanels — built-in engine (live generator counts)', () => {
  it('builds three panels with the right labels, units and series', () => {
    const panels = theaterPanels([
      sample({ t: 1, rps: 100, sent: 100, failed: 0, availPct: 100 }),
      sample({ t: 2, rps: 200, sent: 400, failed: 200, availPct: 80 }),
    ]);
    expect(panels.map((p) => p.label)).toEqual([
      'Mean offered vs successful-response RPS',
      'Generator failures (%)',
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

  it('is zero-safe on a live-gen run before failures land (no NaN)', () => {
    // A built-in run (rps>0) whose first tick has nothing absorbed yet.
    const panels = theaterPanels([sample({ t: 1, rps: 100, sent: 100, failed: 0, availPct: 100 })]);
    expect(panels[0].series[1].points[0]).toEqual([1, 100]); // origin rps = offered
    expect(panels[1].series[0].points[0]).toEqual([1, 0]); // absorbed % = 0, not NaN
    expect(panels[2].series[0].points[0]).toEqual([1, 100]);
  });
});

describe('theaterPanels — external engine (no live generator counts)', () => {
  it('falls back to the two signals the probe measures live: availability + p95 latency', () => {
    const panels = theaterPanels([
      sample({ t: 1, rps: 0, sent: 0, availPct: 100, probeP95: 40 }),
      sample({ t: 2, rps: 0, sent: 0, availPct: 98, probeP95: 55 }),
    ]);
    // No misleading flat-zero offered/absorbed panels.
    expect(panels.map((p) => p.label)).toEqual([
      'Legitimate availability (%)',
      'Legitimate latency p95 (ms)',
    ]);
    expect(panels[0].series[0].points).toEqual([
      [1, 100],
      [2, 98],
    ]);
    expect(panels[1].series[0].points).toEqual([
      [1, 40],
      [2, 55],
    ]);
    expect(panels[1].yFromZero).toBe(true);
  });

  it('omits latency points for ticks with no probe p95 yet (no NaN/undefined leak)', () => {
    const panels = theaterPanels([sample({ t: 1, rps: 0, sent: 0, availPct: 100 })]);
    expect(panels[1].label).toBe('Legitimate latency p95 (ms)');
    expect(panels[1].series[0].points).toEqual([]); // nothing plotted, not [1, undefined]
  });
});

describe('panelsXMax (shared x-domain — no line plotted past the frame)', () => {
  const samples = [
    sample({ t: 0, rps: 0, sent: 0, availPct: 100 }),
    sample({ t: 1, rps: 400, sent: 400, failed: 400, availPct: 100 }),
    sample({ t: 2, rps: 795, sent: 795, failed: 795, availPct: 100 }),
  ];

  it('is the largest elapsed second across the samples (never below 1)', () => {
    expect(panelsXMax(samples)).toBe(2);
    expect(panelsXMax([])).toBe(1);
    expect(panelsXMax([sample({ t: 0 })])).toBe(1);
    // Not rounded down — a fractional last tick must stay inside the domain.
    expect(panelsXMax([sample({ t: 0 }), sample({ t: 2.4 })])).toBe(2.4);
  });

  it('covers every plotted point of every panel, so none overflows [0, xMax]', () => {
    const xMax = panelsXMax(samples);
    for (const p of theaterPanels(samples)) {
      for (const s of p.series) {
        for (const [x] of s.points) {
          expect(x).toBeLessThanOrEqual(xMax);
          expect(x).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

it('does not infer successful responses from unfinished attempts', () => {
  const panels = theaterPanels([
    sample({ t: 1, rps: 100, sent: 100, failed: 0, successful: 10, generatorObserved: true }),
  ]);
  expect(panels[0].series[1].points).toEqual([[1, 10]]);
});
it('separates missing counters from a measured zero and omits missing probes', () => {
  const missing = sample({ t: 1, generatorObserved: false, probeSamples: 0 });
  const zero = sample({
    t: 2,
    generatorObserved: true,
    successful: 0,
    probeSamples: 1,
    availPct: 100,
  });
  expect(theaterPanels([missing, zero])[0].series[0].points).toEqual([[2, 0]]);
  expect(theaterPanels([missing])[0].series[0].points).toEqual([]);
});
it('plots connection counts rather than HTTP rates for slow connections', () => {
  const panels = theaterPanels(
    [sample({ t: 1, sent: 100, failed: 40, successful: 60 })],
    'http-slowloris',
  );
  expect(panels[0].label).toBe('Connections (count)');
  expect(panels[0].series[1].points).toEqual([[1, 60]]);
  expect(panels.some((p) => p.label.includes('RPS'))).toBe(false);
});
