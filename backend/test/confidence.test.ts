import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  EVENT_LOOP_LAG_DEGRADED_MS,
} from '../src/modules/reports/confidence.js';

describe('computeConfidence', () => {
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
});
