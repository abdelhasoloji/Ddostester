/**
 * mitigation/validation.ts — read-only mitigation-validation tier (TTD/TTM).
 *
 * Correlates a run's MEASURED protection timing (TTD = detection, TTM =
 * mitigation) with its load timeline, and reports how the edge behaved BEFORE
 * detection vs AFTER mitigation engaged: the share the edge absorbed, the
 * legitimate availability, and the resulting WRS delta. Pure and side-effect
 * free — it only reads what a run already recorded, generates no traffic, and
 * changes no score. It surfaces what today is implicit (roadmap §1.3): the
 * before/after impact of mitigation on resilience.
 *
 * Honest fallbacks: no measured timing → 'no-measurement' (the run's WRS used a
 * conservative estimate); too few samples → 'insufficient-data'; TTM = 0 →
 * 'not-engaged'. Never fabricates a value.
 */
import { computeWrs } from '../wrs/scoring.js';

/** Minimal shape read from a run's timeline (decoupled from the runner type). */
export interface RunSampleLike {
  /** Seconds since the run started. */
  t: number;
  /** Cumulative requests sent. */
  sent: number;
  /** Cumulative failed requests. */
  failed: number;
  /** Probe availability (%) at this tick. */
  availPct: number;
}

export interface MeasuredProtection {
  source?: string;
  /** TTD — seconds to detect. */
  detectionTimeSec: number;
  /** TTM — seconds to mitigate (0 = never engaged). */
  mitigationTimeSec: number;
}

export interface MitigationInput {
  timeline?: RunSampleLike[];
  protection?: MeasuredProtection;
}

export type MitigationVerdict =
  | 'mitigated'
  | 'partial'
  | 'not-exercised'
  | 'not-engaged'
  | 'no-measurement'
  | 'insufficient-data';

export interface WindowStat {
  fromSec: number;
  toSec: number;
  samples: number;
  /** Share of offered requests the edge absorbed in this window (0..1). */
  absorbedRatio: number;
  /** Mean legitimate availability (%) in this window. */
  availabilityPct: number;
}

export interface MitigationValidation {
  ttdSec?: number;
  ttmSec?: number;
  source?: string;
  before?: WindowStat;
  after?: WindowStat;
  /** after.absorbedRatio − before.absorbedRatio (edge absorbing more = good). */
  absorbedDelta?: number;
  /** after.availabilityPct − before.availabilityPct (probe recovering = good). */
  availabilityDelta?: number;
  /** WRS on the pre-mitigation window (un-mitigated proxy). */
  wrsBefore?: number;
  /** WRS on the post-mitigation window with the measured TTD/TTM. */
  wrsAfter?: number;
  wrsDelta?: number;
  /** The WRS delta is model-based (measured TTD/TTM), not backed by observed absorption. */
  theoretical?: boolean;
  verdict: MitigationVerdict;
  note: string;
}

const round2 = (n: number): number => Number(n.toFixed(2));

/** Cumulative (sent, failed) at the last sample strictly before `sec` (0,0 at t=0). */
function cumAt(timeline: RunSampleLike[], sec: number): { sent: number; failed: number } {
  let acc = { sent: 0, failed: 0 };
  for (const s of timeline) {
    if (s.t < sec) acc = { sent: s.sent, failed: s.failed };
    else break;
  }
  return acc;
}

/** Absorption + mean availability over [fromSec, toSec). */
function windowStat(timeline: RunSampleLike[], fromSec: number, toSec: number): WindowStat {
  const inWin = timeline.filter((s) => s.t >= fromSec && s.t < toSec);
  const start = cumAt(timeline, fromSec);
  const end = cumAt(timeline, toSec);
  const sent = Math.max(0, end.sent - start.sent);
  const failed = Math.max(0, end.failed - start.failed);
  const avail = inWin.length ? inWin.reduce((a, s) => a + s.availPct, 0) / inWin.length : 0;
  return {
    fromSec: round2(fromSec),
    toSec: round2(toSec),
    samples: inWin.length,
    absorbedRatio: sent > 0 ? round2(failed / sent) : 0,
    availabilityPct: round2(avail),
  };
}

/** WRS for a window: availability from the window, TTD/TTM as supplied. */
function windowWrs(availabilityPct: number, ttd: number, ttm: number): number {
  return computeWrs({
    detectionTimeSec: ttd,
    mitigationTimeSec: ttm,
    legitimateSuccessful: Math.round(availabilityPct),
    legitimateTotal: 100,
    adjacentImpactScore: 0,
  }).wrs;
}

/**
 * Validates a run's mitigation from its measured TTD/TTM and load timeline.
 * Pure: reads only, computes only.
 */
export function validateMitigation(run: MitigationInput): MitigationValidation {
  const p = run.protection;
  if (!p) {
    return {
      verdict: 'no-measurement',
      note: 'No measured protection timing — the run scored on a conservative estimate. Wire a lab/scrubber measurement to validate mitigation.',
    };
  }
  const ttd = p.detectionTimeSec;
  const ttm = p.mitigationTimeSec;
  const base = { ttdSec: round2(ttd), ttmSec: round2(ttm), source: p.source };

  const tl = run.timeline;
  if (!tl || tl.length < 3) {
    return {
      ...base,
      verdict: 'insufficient-data',
      note: 'Timeline too short to split before/after windows.',
    };
  }
  if (ttm <= 0) {
    return {
      ...base,
      verdict: 'not-engaged',
      note: 'Mitigation never engaged (TTM = 0) — the edge did not absorb the incident within the run.',
    };
  }

  const lastT = tl[tl.length - 1].t;
  const before = windowStat(tl, 0, ttd);
  const after = windowStat(tl, ttm, lastT + 1);
  if (before.samples < 1 || after.samples < 1) {
    return {
      ...base,
      before,
      after,
      verdict: 'insufficient-data',
      note: 'Detection/mitigation fell outside the observed load window — not enough samples on one side.',
    };
  }

  const absorbedDelta = round2(after.absorbedRatio - before.absorbedRatio);
  const availabilityDelta = round2(after.availabilityPct - before.availabilityPct);
  // Before = un-mitigated proxy: as slow as the whole observed window; after = measured TTD/TTM.
  const wrsBefore = round2(windowWrs(before.availabilityPct, lastT, lastT));
  const wrsAfter = round2(windowWrs(after.availabilityPct, ttd, ttm));
  const wrsDelta = round2(wrsAfter - wrsBefore);
  const common = {
    ...base,
    before,
    after,
    absorbedDelta,
    availabilityDelta,
    wrsBefore,
    wrsAfter,
    wrsDelta,
  };

  // "Exercised" = the target actually saw pressure — the edge absorbed a
  // meaningful share somewhere, or the legitimate probe dipped. Without that
  // there was NO incident to mitigate, so a favourable verdict would overstate
  // resilience (the project's honesty rule). The WRS delta is then purely the
  // theoretical effect of the measured TTD/TTM, not observed mitigation.
  const maxAbsorbed = Math.max(before.absorbedRatio, after.absorbedRatio);
  const minAvail = Math.min(...tl.map((s) => s.availPct));
  const exercised = maxAbsorbed >= 0.05 || minAvail <= 95;

  if (!exercised) {
    return {
      ...common,
      theoretical: true,
      verdict: 'not-exercised',
      note: `No incident exercised — the edge absorbed ~0% and availability held at ${minAvail}%. The WRS delta is theoretical: it reflects the measured TTD/TTM${base.source ? ` (${base.source})` : ''}, not observed mitigation. Validate against a target behind a protection/edge under real load.`,
    };
  }

  const recovered = availabilityDelta >= 0 && absorbedDelta >= 0;
  return {
    ...common,
    theoretical: base.source === 'mock',
    verdict: recovered ? 'mitigated' : 'partial',
    note: recovered
      ? `Edge engaged after ${round2(ttm)}s: absorption ${(before.absorbedRatio * 100).toFixed(0)}%→${(after.absorbedRatio * 100).toFixed(0)}%, availability ${before.availabilityPct}%→${after.availabilityPct}%.`
      : `Mitigation engaged but the target did not clearly recover within the window (availability ${before.availabilityPct}%→${after.availabilityPct}%).`,
  };
}
