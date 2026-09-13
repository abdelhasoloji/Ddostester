import { describe, it, expect } from 'vitest';
import { detectBreakingPoint } from '../src/modules/campaigns/breaking-point.js';
import type { RunSample } from '../src/modules/campaigns/runner.js';

/** Build a timeline of cumulative sent/failed from per-tick (rps, failRate). */
function tl(ticks: { rps: number; ok: number; fail: number }[]): RunSample[] {
  let sent = 0;
  let failed = 0;
  return ticks.map((tk, i) => {
    sent += tk.ok + tk.fail;
    failed += tk.fail;
    return { t: i + 1, rps: tk.rps, sent, failed, probe5xx: 0, availPct: 100 };
  });
}

describe('detectBreakingPoint (P5)', () => {
  it('finds the offered rps where the target starts failing en masse', () => {
    // Clean up to 400 rps, then 600/700 rps mostly fail (target broke).
    const timeline = tl([
      { rps: 100, ok: 100, fail: 0 },
      { rps: 300, ok: 300, fail: 0 },
      { rps: 400, ok: 400, fail: 0 },
      { rps: 600, ok: 120, fail: 480 }, // onset — 80% fail
      { rps: 700, ok: 100, fail: 600 }, // sustained
    ]);
    const bp = detectBreakingPoint(timeline);
    expect(bp.reached).toBe(true);
    expect(bp.rps).toBe(600);
    expect(bp.sustainedRps).toBe(400); // highest clean rate
    expect(bp.failRate).toBeGreaterThan(0.5);
  });

  it('reports no breaking point when the target holds throughout', () => {
    const timeline = tl([
      { rps: 100, ok: 100, fail: 0 },
      { rps: 400, ok: 398, fail: 2 },
      { rps: 800, ok: 790, fail: 10 },
    ]);
    const bp = detectBreakingPoint(timeline);
    expect(bp.reached).toBe(false);
    expect(bp.sustainedRps).toBe(800);
  });

  it('ignores a single-tick blip (needs a sustained breach)', () => {
    const timeline = tl([
      { rps: 200, ok: 200, fail: 0 },
      { rps: 400, ok: 100, fail: 300 }, // one bad tick
      { rps: 400, ok: 400, fail: 0 }, // recovers
      { rps: 500, ok: 500, fail: 0 },
    ]);
    const bp = detectBreakingPoint(timeline);
    expect(bp.reached).toBe(false);
  });

  it('handles an empty/short timeline', () => {
    expect(detectBreakingPoint([]).reached).toBe(false);
    expect(detectBreakingPoint(undefined).sustainedRps).toBe(0);
  });
});
