import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  EVENT_LOOP_LAG_DEGRADED_MS,
} from '../src/modules/reports/confidence.js';

describe('computeConfidence', () => {
  it('withholds clean measurement confidence when attempts lack finalized outcomes', () => {
    expect(computeConfidence({ unfinalizedRequests: 1 }).degraded).toBe(true);
    expect(computeConfidence({ unfinalizedRequests: 0 }).degraded).toBe(false);
  });
  it('is clean when the generator was healthy', () => {
    const c = computeConfidence({ hardStopped: false, peakEventLoopLagMs: 5 });
    expect(c.degraded).toBe(false);
    expect(c.reasons).toHaveLength(0);
  });

  it('flags a hard-stopped run', () => {
    const c = computeConfidence({ hardStopped: true, peakEventLoopLagMs: 2 });
    expect(c.degraded).toBe(true);
    expect(c.reasons[0]).toMatch(/hard backstop/i);
  });

  it('flags high event-loop lag (generator was the bottleneck)', () => {
    const c = computeConfidence({
      hardStopped: false,
      peakEventLoopLagMs: EVENT_LOOP_LAG_DEGRADED_MS + 50,
    });
    expect(c.degraded).toBe(true);
    expect(c.reasons[0]).toMatch(/event-loop lag/i);
  });

  it('does not flag lag exactly at the threshold', () => {
    const c = computeConfidence({ peakEventLoopLagMs: EVENT_LOOP_LAG_DEGRADED_MS });
    expect(c.degraded).toBe(false);
  });

  it('flags a self-inflicted auto-kill (killed while stalled, sent ~no load)', () => {
    const c = computeConfidence({
      killedAuto: true,
      peakEventLoopLagMs: EVENT_LOOP_LAG_DEGRADED_MS + 90,
      generatorRequests: 0,
    });
    expect(c.degraded).toBe(true);
    expect(c.reasons.some((r) => /generator-side/i.test(r))).toBe(true);
  });

  it('does not call an auto-kill self-inflicted when the generator delivered real load', () => {
    const c = computeConfidence({
      killedAuto: true,
      peakEventLoopLagMs: EVENT_LOOP_LAG_DEGRADED_MS + 90,
      generatorRequests: 5000,
    });
    // Still degraded (high lag), but NOT flagged as a self-inflicted kill —
    // the generator was actually loading the target when it went unavailable.
    expect(c.reasons.some((r) => /generator-side/i.test(r))).toBe(false);
  });

  it('does not flag a self-inflicted kill on a clean-loop auto-kill (real target failure)', () => {
    const c = computeConfidence({
      killedAuto: true,
      peakEventLoopLagMs: 8,
      generatorRequests: 0,
    });
    expect(c.degraded).toBe(false);
  });
});
