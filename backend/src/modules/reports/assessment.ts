import { computeAbsorption } from './absorption.js';
import { scenarioMeanRps } from '../campaigns/calibration.js';
import type { Campaign } from '../campaigns/model.js';
import { computeConfidence, fleetCpuContention, remoteProbeQualityReasons } from './confidence.js';
import type { CampaignRun } from '../campaigns/runner.js';
import type { WrsLevel } from '../wrs/scoring.js';
import { wrsLevel } from '../wrs/scoring.js';
import { observedAvailability } from './measurements.js';

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
  | 'breached' // probe-failure threshold or attributed automatic stop
  | 'inconclusive'; // the measurement can't prove resilience (under-delivered / degraded / contended / aborted)

/** Below this fraction of the configured rate, a rate-based vector never reached its intensity. */
export const DELIVERY_MIN = 0.7;
/** At/below this absorbed fraction the origin effectively served the load itself. */
const SERVED_ABSORB_MAX = 0.05;
/** Fewer than half of completed probe transactions succeeded; not an outage-duration measure. */
const AVAIL_BREACH = 50;

export interface VectorContext {
  shape: string;
  drs: string;
  status: CampaignRun['status'] | string;
  /** Campaign vector — 'http-get' | 'http-post' | 'http-slowloris'. */
  vector?: string;
  h2Confirmed?: boolean;
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
  /** The scenario's intended mean offered rate (delivery denominator). */
  expectedRps: number;
  achievedRps: number;
  originRps: number;
  /** achieved / expected offered rate, in [0,1]; 1 when no rate is known. */
  deliveryRatio: number;
  underDelivered: boolean;
  availabilityPct: number | null;
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
  const measuredAvailability = run ? observedAvailability(run) : null;
  const avail = measuredAvailability ?? 0;
  const cal = run?.calibration;
  const recordedPeak = a?.configuredRps ?? run?.generator.config?.maxRps ?? 0;
  const configuredRps = cal?.calibrated ? Math.max(recordedPeak, cal.requestedRps) : recordedPeak;
  // The rate the scenario meant to offer (its mean) — the honest denominator for
  // delivery. Equals the peak for a constant profile; lower for a wave/ramp. A
  // faithfully-delivered wave's mean is ~73% of its peak, a ramp's ~58%, so
  // measuring delivery against the peak would falsely flag them under-delivered.
  const recordedMean = a?.expectedRps ?? recordedPeak;
  // Keep the originally requested exposure as the denominator after calibration.
  const expectedRps =
    recordedPeak > 0 ? (recordedMean * configuredRps) / recordedPeak : configuredRps;
  const achievedRps = a?.achievedRps ?? (run ? run.generator.actualRps : 0);
  const originRps = a?.originRps ?? 0;
  const absorbedRatio = a?.absorbedRatio ?? 0;
  const rejectedRatio = a?.rejectedRatio ?? 0;
  const tarpitRatio = a?.tarpitRatio ?? 0;
  // Delivery: a rate-based vector must actually reach the rate its scenario meant
  // to offer for the result to mean anything. Slow-connection vectors trickle by
  // design — exempt.
  const deliveryRatio = expectedRps > 0 ? Math.min(1, achievedRps / expectedRps) : 1;
  const underDelivered = !isSlow && expectedRps > 0 && deliveryRatio < DELIVERY_MIN;

  const wrs = run?.wrs?.wrs ?? ctx.wrs ?? null;
  const level = run?.wrs?.level ?? ctx.level ?? (wrs != null ? wrsLevel(wrs) : null);

  const caveats: string[] = [];
  const noProbe = !!run && measuredAvailability === null;
  const approximation = /rapid.?reset|continuation|thor|pulsewave|carpet.bombing/i.test(ctx.shape);
  const intendedUrls = run?.generator.config?.endpoints?.map((e) => e.url) ?? [];
  const primaryUrl = run?.generator.config?.execution?.probeUrl;
  const monitoredUrls =
    run?.probe.endpoints?.filter((e) => e.samples > 0).map((e) => e.url) ??
    (primaryUrl ? [primaryUrl] : []);
  const missingCoverage =
    intendedUrls.length > 0 && intendedUrls.some((url) => !monitoredUrls.includes(url));
  if (approximation)
    caveats.push(
      'This bounded HTTP approximation does not implement the named protocol abuse or distributed mechanism; completion cannot establish resilience to that mechanism.',
    );
  if (missingCoverage)
    caveats.push(
      'Functional probe coverage does not include every requested endpoint. Availability describes only the monitored checks, not the entire target.',
    );
  if ((run?.probe.endpoints?.length ?? 0) > 1)
    caveats.push(
      'Availability counts complete probe cycles: every monitored GET check must succeed. It does not validate authenticated or POST transactions. Baseline latency on the primary URL is not comparable with the maximum latency across these checks.',
    );
  const unsupportedH2 =
    /http\/?2|rapid.?reset|continuation/i.test(ctx.shape) && ctx.h2Confirmed !== true;
  if (noProbe) caveats.push('No completed probe observations; availability is unknown.');
  if (run && run.probe.samples > 0 && run.probe.samples < 10)
    caveats.push(
      `Only ${run.probe.samples} probe observations; cumulative availability has coarse resolution and does not establish continuous service availability.`,
    );
  if (unsupportedH2)
    caveats.push(
      'HTTP/2 was not confirmed at this target; this bounded HTTP run cannot establish HTTP/2 resilience.',
    );
  if (run?.generator.fleet?.measurementComplete === false)
    caveats.push(
      'Fleet evidence is incomplete; this run cannot establish a complete resilience verdict.',
    );
  if (underDelivered) {
    caveats.push(
      `Delivered only ${Math.round(deliveryRatio * 100)}% of the intended offered rate ` +
        `(${Math.round(achievedRps)}/${Math.round(expectedRps)} req/s) — a generator-side shortfall, ` +
        `so resilience at the full DRS ${ctx.drs} rate is unproven.`,
    );
  }
  if (cal?.calibrated) {
    caveats.push(
      `Rate-calibrated: the requested ${cal.requestedRps} req/s exceeded what the generator ` +
        `could deliver against this target on one box (measured ${cal.deliveredRps} req/s), so ` +
        `the graded run was offered at ${cal.appliedRps} req/s. This calibration is not proof of successful mitigation at ${cal.appliedRps} req/s; ` +
        `proving resilience at the full ${cal.requestedRps} req/s requires further generator and target qualification.`,
    );
  }
  if (run?.confidence?.degraded) caveats.push(...(run.confidence.reasons ?? []));
  if (run?.probeContended) {
    caveats.push(
      'The independent probe and generator disagree; the cause is uncertain. ' +
        'Raw probe availability and safety thresholds were preserved.',
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

  const secondaryBaselineMissing =
    (run?.probe.endpoints?.length ?? 0) > 1 &&
    (run?.probe.endpoints ?? []).some((e) => {
      if (e.url === primaryUrl) return false;
      const b = run?.probeBaselines?.find((b) => b.url === e.url)?.metrics;
      return (
        !b ||
        b.samples < 1 ||
        b.availabilityPct !== 100 ||
        b.observation?.complete === false ||
        Boolean(b.quality && remoteProbeQualityReasons(b.quality).length)
      );
    });
  const baselineMissing =
    secondaryBaselineMissing ||
    run?.baseline?.observation?.complete === false ||
    Boolean(run?.baseline?.quality && remoteProbeQualityReasons(run.baseline.quality).length);
  if (baselineMissing)
    caveats.push(
      'Baseline observations for the monitored routes or resource diagnostics are incomplete or unhealthy; no reliable pre-load comparison is available.',
    );
  const reducedCalibration = cal?.calibrated === true && cal.appliedRps < cal.requestedRps;
  // Verdict — tied to what the measurement can prove.
  let verdict: VectorVerdict;
  if (noProbe || unsupportedH2 || approximation || missingCoverage || reducedCalibration)
    verdict = 'inconclusive';
  else if (ctx.status === 'KILLED_AUTO')
    verdict =
      run?.probeContended ||
      baselineMissing ||
      run?.confidence?.degraded ||
      run?.generator.fleet?.measurementComplete === false
        ? 'inconclusive'
        : 'breached';
  else if (ctx.status === 'KILLED_MANUAL') verdict = 'inconclusive';
  else if (!run) verdict = 'inconclusive';
  else if (
    underDelivered ||
    baselineMissing ||
    run.confidence?.degraded ||
    run.generator.fleet?.measurementComplete === false
  )
    verdict = 'inconclusive';
  else if (avail >= 99) verdict = 'held';
  else if (avail < AVAIL_BREACH && !run.probeContended) verdict = 'breached';
  else verdict = 'partial';

  const confident =
    Boolean(run) &&
    !noProbe &&
    !unsupportedH2 &&
    !approximation &&
    !missingCoverage &&
    !reducedCalibration &&
    ctx.status === 'COMPLETED' &&
    !baselineMissing &&
    !underDelivered &&
    !run?.confidence?.degraded &&
    run?.generator.fleet?.measurementComplete !== false &&
    !run?.probeContended;

  let observation = !run
    ? 'No run data; delivered load and legitimate availability are unknown. No resilience verdict.'
    : noProbe
      ? 'Probe availability is unknown; no resilience verdict.'
      : buildObservation({
          mechanism,
          verdict,
          isSlow,
          availPct: Math.round(avail),
          originRps: Math.round(originRps),
          achievedRps: Math.round(achievedRps),
          configuredRps,
          expectedRps: Math.round(expectedRps),
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
      ` (Rate-calibrated: observed at ${cal.appliedRps} req/s — the deliverable ceiling here — ` +
      `not the requested ${cal.requestedRps} req/s.)`;
  }

  return {
    shape: ctx.shape,
    drs: ctx.drs,
    status: ctx.status,
    vector: ctx.vector,
    isSlowConnection: isSlow,
    configuredRps,
    expectedRps: Math.round(expectedRps),
    achievedRps: Math.round(achievedRps),
    originRps: Math.round(originRps),
    deliveryRatio,
    underDelivered,
    availabilityPct: measuredAvailability === null ? null : Math.round(avail * 10) / 10,
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
  expectedRps: number;
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
    return `Automatic stop — ${x.availPct}% of completed legitimate probe transactions succeeded. ${x.statusDetail ?? 'The safety kill-switch stopped the run.'}`;
  }
  if (x.verdict === 'breached') {
    // A completed run that nonetheless drove legitimate availability below the
    // breach floor — most completed probe transactions failed.
    const mech = describeMechanism(x.mechanism, x.originRps, x.absorbedPct, x.isSlow);
    const tail = x.wrs != null ? ` WRS ${x.wrs} (${x.level}).` : '';
    return (
      `Not held — ${x.availPct}% of completed legitimate probe transactions succeeded; ` +
      `the majority failed. These samples do not establish outage duration. ${mech}.${tail}`
    );
  }
  if (x.status === 'KILLED_MANUAL') {
    return `Run aborted manually — ${x.statusDetail ?? 'stopped by an operator'}; no resilience verdict.`;
  }
  const wrsTail = x.wrs != null ? ` WRS ${x.wrs} (${x.level}).` : '';
  if (x.underDelivered) {
    return (
      `Delivered only ${Math.round(x.deliveryRatio * 100)}% of the intended offered rate ` +
      `(${x.achievedRps}/${x.expectedRps} req/s) — a generator-side shortfall, so this is ` +
      `INCONCLUSIVE at the DRS ${x.drs} rate. At the delivered rate successful HTTP responses were observed and ` +
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
        ? `Slow connections remained open; this alone does not establish mitigation`
        : `Successful HTTP responses: ~${originRps} req/s; generator failure ratio: ${absorbedPct}% (origin/edge attribution requires telemetry)`;
    case 'shed':
      return `Slow/incomplete connections closed; the closure cause requires target telemetry`;
    case 'rejected':
      return `HTTP failures (4xx/5xx): ${absorbedPct}% of offered requests; cause unproven`;
    case 'tarpitted':
      return `Transport failures: ${absorbedPct}% of offered requests; timeouts do not prove edge tarpitting`;
    case 'blocked':
      return `Generator failures: ${absorbedPct}% of offered requests (no per-status breakdown; attribution unavailable)`;
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

/** Derived display projection; old evidence remains unchanged in storage. */
export function assessCampaignRun(
  run: CampaignRun,
  campaign?: Partial<Campaign>,
): VectorAssessment {
  const g = run.generator;
  const configuredRps = campaign?.maxRps ?? g.config?.maxRps ?? 0;
  const absorption =
    run.absorption ??
    computeAbsorption({
      configuredRps,
      expectedRps: scenarioMeanRps(configuredRps, campaign?.scenario),
      achievedRps: g.actualRps,
      totalRequests: g.totalRequests,
      successful: g.successful,
      failed: g.failed,
      durationSec: g.actualRps > 0 ? g.totalRequests / g.actualRps : 0,
    });
  const confidence =
    run.confidence ??
    computeConfidence({
      unfinalizedRequests: g.unfinalizedRequests,
      hardStopped: g.hardStopped,
      fleetIncomplete: g.fleet?.measurementComplete === false,
      fleetCpuContention: fleetCpuContention(g.fleet?.shards),
    });
  return assessVector(
    { ...run, absorption, confidence },
    {
      shape: campaign?.name ?? run.campaignId,
      drs: /DRS\s*([0-9])/i.exec(campaign?.name ?? '')?.[1] ?? '—',
      status: run.status,
      vector: campaign?.vector,
      h2Confirmed: campaign?.reconPosture?.h2,
    },
  );
}
