import type { CampaignRun } from '../campaigns/runner.js';
import type { WrsLevel } from '../wrs/scoring.js';
import { wrsLevel } from '../wrs/scoring.js';
import { availabilityPct } from '../../util/run-metrics.js';

/**
 * Dedicated assessment engine — the single source of truth that turns the REAL
 * measured run data into a faithful per-vector verdict. Every report (suite,
 * per-run, compliance) should read its verdict/mechanism/aggregates from here so
 * the narrative can never drift from what actually happened.
 *
 * Grounding notes (why the old ad-hoc logic in the renderers was wrong):
 *  - `generator.statusCounts` is EMPTY for out-of-process engines (vegeta/k6),
 *    so any "rejected 4xx/5xx vs tarpit" split derived from it is blind. We key
 *    the mechanism on `absorption` (originRps / absorbedRatio / rejected/tarpit
 *    when present) and on successful/failed — never on statusCounts — and say so
 *    honestly ("mechanism not resolved") when the breakdown is unavailable.
 *  - A vector that under-delivered (achieved ≪ configured rps — a generator-side
 *    shortfall, `absorption.offeredShortfall`) never actually reached its target
 *    intensity, so a confident "held / A+" overstates resilience. Such a run is
 *    scored INCONCLUSIVE, not "fully mitigated".
 *  - `probeContended` (PF1) means the probe lost the connection race to the flood
 *    at the target, NOT a target outage — so an auto-kill under contention is
 *    inconclusive, not a breach.
 */

/** How the target handled the offered load. */
export type Mechanism =
  | 'served' // the origin served the load directly — the edge absorbed ~nothing
  | 'rejected' // the edge rejected it with a response (4xx/5xx)
  | 'tarpitted' // the edge held connections until they timed out / aborted
  | 'shed' // (slow-connection vectors) the target shed the slow/incomplete connections
  | 'blocked' // the edge blocked it, but the mechanism can't be resolved (no per-status detail)
  | 'unknown';

/** The resilience verdict for one vector, tied to what the measurement can prove. */
export type VectorVerdict =
  | 'held' // legitimate availability held; a valid test at the delivered rate
  | 'partial' // some legitimate impact (availability dipped) but the target stayed up
  | 'breached' // the target went unavailable (a real, attributed auto-kill)
  | 'inconclusive'; // the measurement can't prove resilience (under-delivered / degraded / contended / aborted)

/** Below this fraction of the configured rate, a rate-based vector never reached its intensity. */
export const DELIVERY_MIN = 0.7;
/** At/below this absorbed fraction the origin effectively served the load itself. */
const SERVED_ABSORB_MAX = 0.05;

export interface VectorContext {
  shape: string;
  drs: string;
  status: CampaignRun['status'] | string;
  /** Campaign vector — 'http-get' | 'http-post' | 'http-slowloris'. */
  vector?: string;
  /** Fallback WRS/level when the full run object isn't loaded (the suite member carries them). */
  wrs?: number | null;
  level?: WrsLevel | null;
}

export interface VectorAssessment {
  shape: string;
  drs: string;
  status: string;
  vector?: string;
  isSlowConnection: boolean;
  configuredRps: number;
  achievedRps: number;
  originRps: number;
  /** achieved / configured, in [0,1]; 1 when no configured rate is known. */
  deliveryRatio: number;
  underDelivered: boolean;
  availabilityPct: number;
  absorbedPct: number;
  rejectedPct: number;
  tarpitPct: number;
  wrs: number | null;
  level: WrsLevel | null;
  mechanism: Mechanism;
  verdict: VectorVerdict;
  /** Whether the measurement is trustworthy enough to state resilience at the target rate. */
  confident: boolean;
  /** Machine-readable caveats (under-delivery, degraded, probe-contended, no breakdown, …). */
  caveats: string[];
  /** One faithful sentence describing what happened (for the per-attack block). */
  observation: string;
  /** Short mitigation label for tables ('held' | 'partial' | 'breached' | 'inconclusive'). */
  label: VectorVerdict;
}

const pct1 = (r: number): number => Math.round(Math.max(0, Math.min(1, r)) * 1000) / 10;

/** Assess one vector from its real run. Pure. */
export function assessVector(run: CampaignRun | undefined, ctx: VectorContext): VectorAssessment {
  const isSlow = ctx.vector === 'http-slowloris' || /slowloris/i.test(ctx.shape);
  const a = run?.absorption;
  const avail = run ? availabilityPct(run) : 0;
  const configuredRps = a?.configuredRps ?? 0;
  const achievedRps = a?.achievedRps ?? (run ? run.generator.actualRps : 0);
  const originRps = a?.originRps ?? 0;
  const absorbedRatio = a?.absorbedRatio ?? 0;
  const rejectedRatio = a?.rejectedRatio ?? 0;
  const tarpitRatio = a?.tarpitRatio ?? 0;
  // Delivery: a rate-based vector must actually reach its configured rate for the
  // result to mean anything. Slow-connection vectors trickle by design — exempt.
  const deliveryRatio = configuredRps > 0 ? Math.min(1, achievedRps / configuredRps) : 1;
  const underDelivered = !isSlow && configuredRps > 0 && deliveryRatio < DELIVERY_MIN;

  const wrs = run?.wrs?.wrs ?? ctx.wrs ?? null;
  const level = run?.wrs?.level ?? ctx.level ?? (wrs != null ? wrsLevel(wrs) : null);

  const caveats: string[] = [];
  if (underDelivered) {
    caveats.push(
      `Delivered only ${Math.round(deliveryRatio * 100)}% of the configured rate ` +
        `(${Math.round(achievedRps)}/${configuredRps} req/s) — a generator-side shortfall, ` +
        `so resilience at the full DRS ${ctx.drs} rate is unproven.`,
    );
  }
  const cal = run?.calibration;
  if (cal?.calibrated) {
    caveats.push(
      `Rate-calibrated: the requested ${cal.requestedRps} req/s exceeded what the generator ` +
        `could deliver against this target on one box (measured ${cal.deliveredRps} req/s), so ` +
        `the graded run was offered at ${cal.appliedRps} req/s. The verdict is valid AT ${cal.appliedRps} req/s; ` +
        `proving resilience at the full ${cal.requestedRps} req/s needs multi-box generation.`,
    );
  }
  if (run?.confidence?.degraded) caveats.push(...(run.confidence.reasons ?? []));
  if (run?.probeContended) {
    caveats.push(
      'The legitimate probe lost the connection race to the flood at the target (probe-contended), ' +
        'so availability was derived from generator success, not the probe.',
    );
  }

  // Mechanism — keyed on absorption, never on statusCounts (empty on external engines).
  let mechanism: Mechanism;
  if (!run) mechanism = 'unknown';
  else if (isSlow)
    // For a slow-connection vector, transport timeouts/aborts mean the target SHED
    // the incomplete connections (the correct defense); little absorption = it held them.
    mechanism = tarpitRatio > 0 || absorbedRatio > SERVED_ABSORB_MAX ? 'shed' : 'served';
  else if (absorbedRatio <= SERVED_ABSORB_MAX) mechanism = 'served';
  else if (rejectedRatio <= 0 && tarpitRatio <= 0)
    // The edge blocked a real fraction but neither 4xx/5xx nor transport errors were
    // resolved — the out-of-process engine reports no per-status breakdown.
    mechanism = 'blocked';
  else if (rejectedRatio >= tarpitRatio) mechanism = 'rejected';
  else mechanism = 'tarpitted';

  // Verdict — tied to what the measurement can prove.
  let verdict: VectorVerdict;
  if (ctx.status === 'KILLED_AUTO') verdict = run?.probeContended ? 'inconclusive' : 'breached';
  else if (ctx.status === 'KILLED_MANUAL') verdict = 'inconclusive';
  else if (!run) verdict = 'inconclusive';
  else if (underDelivered || run.confidence?.degraded) verdict = 'inconclusive';
  else if (avail >= 99) verdict = 'held';
  else verdict = 'partial';

  const confident =
    ctx.status === 'COMPLETED' &&
    !underDelivered &&
    !run?.confidence?.degraded &&
    !run?.probeContended;

  let observation = buildObservation({
    mechanism,
    verdict,
    isSlow,
    availPct: Math.round(avail),
    originRps: Math.round(originRps),
    achievedRps: Math.round(achievedRps),
    configuredRps,
    absorbedPct: a?.absorbedPct ?? 0,
    wrs,
    level,
    underDelivered,
    deliveryRatio,
    drs: ctx.drs,
    statusDetail: run?.statusDetail,
    status: ctx.status,
  });
  // Be explicit when the graded rate was the calibrated deliverable ceiling, so
  // the verdict is never mistaken for one proven at the full requested rate.
  if (cal?.calibrated) {
    observation +=
      ` (Rate-calibrated: graded at ${cal.appliedRps} req/s — the deliverable ceiling here — ` +
      `not the requested ${cal.requestedRps} req/s.)`;
  }

  return {
    shape: ctx.shape,
    drs: ctx.drs,
    status: ctx.status,
    vector: ctx.vector,
    isSlowConnection: isSlow,
    configuredRps,
    achievedRps: Math.round(achievedRps),
    originRps: Math.round(originRps),
    deliveryRatio,
    underDelivered,
    availabilityPct: Math.round(avail),
    absorbedPct: a?.absorbedPct ?? 0,
    rejectedPct: pct1(rejectedRatio),
    tarpitPct: pct1(tarpitRatio),
    wrs,
    level,
    mechanism,
    verdict,
    confident,
    caveats,
    observation,
    label: verdict,
  };
}

function buildObservation(x: {
  mechanism: Mechanism;
  verdict: VectorVerdict;
  isSlow: boolean;
  availPct: number;
  originRps: number;
  achievedRps: number;
  configuredRps: number;
  absorbedPct: number;
  wrs: number | null;
  level: WrsLevel | null;
  underDelivered: boolean;
  deliveryRatio: number;
  drs: string;
  statusDetail?: string;
  status: string;
}): string {
  if (x.status === 'KILLED_AUTO' && x.verdict === 'breached') {
    return `Not mitigated — the target went unavailable (${x.availPct}% legitimate availability). ${x.statusDetail ?? 'The safety kill-switch stopped the run.'}`;
  }
  if (x.status === 'KILLED_MANUAL') {
    return `Run aborted manually — ${x.statusDetail ?? 'stopped by an operator'}; no resilience verdict.`;
  }
  const wrsTail = x.wrs != null ? ` WRS ${x.wrs} (${x.level}).` : '';
  if (x.underDelivered) {
    return (
      `Delivered only ${Math.round(x.deliveryRatio * 100)}% of the DRS ${x.drs} target rate ` +
      `(${x.achievedRps}/${x.configuredRps} req/s) — a generator-side shortfall, so this is ` +
      `INCONCLUSIVE at full rate. At the delivered rate the origin served the load and ` +
      `legitimate availability held at ${x.availPct}%.${wrsTail}`
    );
  }
  const mech = describeMechanism(x.mechanism, x.originRps, x.absorbedPct, x.isSlow);
  const availClause =
    x.availPct >= 99
      ? `legitimate availability held at ${x.availPct}%`
      : `legitimate availability dipped to ${x.availPct}%`;
  return `${mech}; ${availClause}.${wrsTail}`;
}

function describeMechanism(
  m: Mechanism,
  originRps: number,
  absorbedPct: number,
  isSlow: boolean,
): string {
  switch (m) {
    case 'served':
      return isSlow
        ? `The target held the slow connections open (little shedding)`
        : `The origin served the load directly (~${originRps} req/s reached origin; the edge absorbed ${absorbedPct}%)`;
    case 'shed':
      return `The target shed the slow/incomplete connections (request/header timeout) — the correct defense`;
    case 'rejected':
      return `The edge rejected ${absorbedPct}% of the offered load with a response (4xx/5xx)`;
    case 'tarpitted':
      return `The edge held ${absorbedPct}% of the connections until they timed out (tarpit)`;
    case 'blocked':
      return `The edge blocked ${absorbedPct}% of the offered load (mechanism not resolved — the out-of-process engine reports no per-status breakdown)`;
    default:
      return `No run data`;
  }
}

// ── Suite-level aggregation ────────────────────────────────────────────────────

export interface SuiteAssessment {
  vectors: VectorAssessment[];
  total: number;
  held: number;
  partial: number;
  breached: number;
  inconclusive: number;
  /** Vectors that delivered at their target rate AND weren't degraded/contended. */
  validAtRate: number;
  worstWrs: number | null;
  avgWrs: number | null;
  worstLevel: WrsLevel | '—';
  maxDrs: string;
  worstRisk: 'Low' | 'Medium' | 'Critical';
  /** A meaningful one-line headline (never the meaningless "mean absorbed"). */
  headline: string;
}

const RISK_BY_VERDICT: Record<VectorVerdict, 'Low' | 'Medium' | 'Critical'> = {
  held: 'Low',
  inconclusive: 'Medium',
  partial: 'Medium',
  breached: 'Critical',
};

/** Aggregate per-vector assessments into a worst-case suite verdict. Pure. */
export function assessSuite(vectors: VectorAssessment[]): SuiteAssessment {
  const scored = vectors.filter((v) => v.wrs != null);
  const held = vectors.filter((v) => v.verdict === 'held').length;
  const partial = vectors.filter((v) => v.verdict === 'partial').length;
  const breached = vectors.filter((v) => v.verdict === 'breached').length;
  const inconclusive = vectors.filter((v) => v.verdict === 'inconclusive').length;
  const validAtRate = vectors.filter((v) => v.confident).length;
  const worstWrs = scored.length ? Math.min(...scored.map((v) => v.wrs as number)) : null;
  const avgWrs = scored.length
    ? Math.round((scored.reduce((s, v) => s + (v.wrs as number), 0) / scored.length) * 10) / 10
    : null;
  const worstLevel = worstWrs != null ? wrsLevel(worstWrs) : '—';
  const maxDrs = vectors.reduce((mx, v) => (v.drs !== '—' && v.drs > mx ? v.drs : mx), '0');
  const worstRisk = vectors.some((v) => RISK_BY_VERDICT[v.verdict] === 'Critical')
    ? 'Critical'
    : vectors.some((v) => RISK_BY_VERDICT[v.verdict] === 'Medium')
      ? 'Medium'
      : 'Low';

  const parts: string[] = [];
  parts.push(`${held}/${vectors.length} vectors held at their delivered rate`);
  if (partial) parts.push(`${partial} partial`);
  if (breached) parts.push(`${breached} breached`);
  if (inconclusive)
    parts.push(`${inconclusive} inconclusive (under-delivered or degraded — not a valid test)`);
  const headline =
    (worstWrs != null ? `Worst WRS ${worstWrs} (${worstLevel}). ` : '') + parts.join(' · ') + '.';

  return {
    vectors,
    total: vectors.length,
    held,
    partial,
    breached,
    inconclusive,
    validAtRate,
    worstWrs,
    avgWrs,
    worstLevel,
    maxDrs,
    worstRisk,
    headline,
  };
}
