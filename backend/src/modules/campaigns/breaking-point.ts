/**
 * Breaking-point detection (P5): from a run's per-second timeline, find the
 * offered rate at which the TARGET started to break — i.e. the generator's
 * requests began failing en masse. We deliberately key off the GENERATOR's
 * per-second failure rate (a target-side signal) rather than the legit probe's
 * availability, which can be a false negative when the probe loses the
 * connection race to the flood (see probe-contention / PF1). Pure + testable.
 */
import type { RunSample } from './runner.js';

export interface BreakingPoint {
  /** Did the target degrade within this run's offered load? */
  reached: boolean;
  /** Offered requests/s at the onset of the degradation (when reached). */
  rps?: number;
  /** Elapsed seconds at the onset. */
  atSec?: number;
  /** The per-second failure ratio that tripped the detection (0..1). */
  failRate?: number;
  /** The highest offered rps the target sustained WITHOUT breaking. */
  sustainedRps: number;
}

export interface BreakingPointOptions {
  /** Per-second failure ratio that counts as "breaking" (default 0.3 = 30%). */
  failThreshold?: number;
  /** Consecutive ticks the threshold must hold, to ignore a single blip (default 2). */
  sustainTicks?: number;
  /** Ignore the first ramp seconds where rates are tiny (default 20 offered rps). */
  minRps?: number;
}

/**
 * Scans the timeline for the first SUSTAINED spike in the generator's per-second
 * failure rate and reports the offered rps at its onset, plus the highest rps the
 * target sustained cleanly. `reached:false` means the target held across the whole
 * offered load (no breaking point within the run's caps).
 */
export function detectBreakingPoint(
  timeline: RunSample[] | undefined,
  opts: BreakingPointOptions = {},
): BreakingPoint {
  const failThreshold = opts.failThreshold ?? 0.3;
  const sustainTicks = Math.max(1, opts.sustainTicks ?? 2);
  const minRps = opts.minRps ?? 20;
  const tl = timeline ?? [];

  let sustainedRps = 0;
  let breachRun = 0;
  let onsetIdx = -1;

  for (let i = 1; i < tl.length; i++) {
    const dSent = tl[i].sent - tl[i - 1].sent;
    const dFailed = tl[i].failed - tl[i - 1].failed;
    const offered = tl[i].rps;
    if (offered < minRps || dSent <= 0) {
      breachRun = 0;
      continue;
    }
    const failRate = dFailed / dSent;
    if (failRate >= failThreshold) {
      if (breachRun === 0) onsetIdx = i; // remember where the breach started
      breachRun += 1;
      if (breachRun >= sustainTicks) {
        const onset = tl[onsetIdx];
        return {
          reached: true,
          rps: Math.round(onset.rps),
          atSec: onset.t,
          failRate: Number((dFailed / dSent).toFixed(2)),
          sustainedRps: Math.round(sustainedRps),
        };
      }
    } else {
      breachRun = 0;
      // A clean tick at this rate → the target sustained at least this much.
      if (offered > sustainedRps) sustainedRps = offered;
    }
  }
  return { reached: false, sustainedRps: Math.round(sustainedRps) };
}
