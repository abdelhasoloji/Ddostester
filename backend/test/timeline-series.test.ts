import { describe, it, expect } from 'vitest';
import {
  counterIntervals,
  finalizedFailureIntervals,
  probeCheckIntervals,
  plotSeries,
  cleanTimeline,
  type TimelineSample,
} from '../src/modules/reports/timeline-series.js';
const tick = (t: number, sent: number): TimelineSample => ({
  t,
  sent,
  rps: 0,
  successful: sent,
  failed: 0,
  availPct: 100,
  generatorObserved: true,
});
describe('shared retained timeline evidence', () => {
  it('preserves a burst and breaks a trace around missing counters and resets', () => {
    const rows = counterIntervals(
      [
        tick(0, 0),
        tick(1, 10),
        { ...tick(2, 20), generatorObserved: false },
        tick(3, 30),
        tick(4, 60),
        tick(5, 2),
        tick(6, 7),
      ],
      (s) => s.sent,
    );
    expect(plotSeries(rows)).toEqual({
      points: [
        [1, 10],
        [4, 30],
        [6, 5],
      ],
      breakBefore: [4, 6],
    });
  });
  it('does not reinterpret legacy rate-only placeholders as measured zero counters', () => {
    expect(
      counterIntervals(
        [
          { ...tick(1, 0), generatorObserved: undefined, rps: 10 },
          { ...tick(2, 0), generatorObserved: undefined, rps: 10 },
        ],
        (s) => s.sent,
      ).every((p) => p.y === null),
    ).toBe(true);
  });
  it('counts finalized failures even when there are no newly emitted requests', () => {
    expect(
      plotSeries(
        finalizedFailureIntervals([
          { ...tick(1, 10), successful: 0 },
          { ...tick(2, 10), successful: 8, failed: 2 },
        ]),
      ).points,
    ).toEqual([[2, 20]]);
  });
  it('keeps unknown, measured zero and skipped probe observations distinct', () => {
    const rows = [
      { ...tick(0, 0), probeSamples: 0, probeAvailable: 0 },
      { ...tick(1, 1), probeSamples: 1, probeAvailable: 1 },
      { ...tick(2, 2), probeSamples: 1, probeAvailable: 1 },
      { ...tick(3, 3), probeSamples: 2, probeAvailable: 1 },
    ];
    expect(plotSeries(probeCheckIntervals(rows).rows).points).toEqual([
      [1, 100],
      [3, 0],
    ]);
    expect(plotSeries(probeCheckIntervals(rows, 'http://not-observed/').rows).points).toEqual([]);
  });
  it('includes the real checks in the first retained counter snapshot exactly once', () => {
    const a = { ...tick(4, 40), probeSamples: 3, probeAvailable: 2 };
    const b = { ...tick(5, 50), probeSamples: 3, probeAvailable: 2 };
    expect(plotSeries(probeCheckIntervals([a, b]).rows).points).toEqual([[4, 200 / 3]]);
  });
  it('normalizes duplicate timestamps without introducing a negative or invalid time axis', () => {
    expect(
      cleanTimeline([tick(2, 2), tick(NaN, 3), tick(-1, 0), tick(1, 1), tick(2, 4)]).map((s) => [
        s.t,
        s.sent,
      ]),
    ).toEqual([
      [1, 1],
      [2, 4],
    ]);
  });
});
