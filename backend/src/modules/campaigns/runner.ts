import type { LoadTestConfig, LoadTestResult } from '../../engine/types.js';
import type { LoadProgress } from '../../engine/loadTest.js';
import { KillSwitch, Probe } from '../probe/probe.js';
import type { ProbeMetrics } from '../probe/probe.js';
import type { PostureReport } from '../posture/analyze.js';
import { computeWrs } from '../wrs/scoring.js';
import type { WrsBreakdown } from '../wrs/scoring.js';
import { BuiltinHttpAgent } from '../../agents/builtin.js';
import type { AttackAgent } from '../../agents/types.js';
import { noopProtectionProvider } from '../protection/provider.js';
import type { ProtectionProvider } from '../protection/types.js';
import { evaluateAcceptance } from './acceptance.js';
import type { AcceptanceResult } from './acceptance.js';
import { captureBaseline, computeBaselineDelta } from './baseline.js';
import type { BaselineDelta, BaselineMetrics, CaptureBaseline } from './baseline.js';
import { noopTargetTelemetryProvider } from '../target-telemetry/provider.js';
import type { TargetSample, TargetTelemetryProvider } from '../target-telemetry/types.js';
import { probeLimitsFromEnv, ESTIMATED_TIMINGS } from '../../config/limits.js';
import type { RunConfidence } from '../reports/confidence.js';
import type { Absorption } from '../reports/absorption.js';
import type { AbsorptionCorroboration } from '../edge-absorption/types.js';
import type { Campaign } from './model.js';

/** One ~1s snapshot captured during a run (persisted for after-the-fact graphs). */
export interface RunSample {
  /** Seconds since the run started. */
  t: number;
  /** Generator requests/s at this tick (0 for engines that don't report counters). */
  rps: number;
  /** Cumulative requests sent. */
  sent: number;
  /** Cumulative failed requests. */
  failed: number;
  /** Probe 5xx error rate (%) at this tick. */
  probe5xx: number;
  /** Probe availability (%) at this tick. */
  availPct: number;
}

/** Cap the stored series defensively (1/s over the 15-min max is 900 points). */
const MAX_RUN_SAMPLES = 1000;

export interface CampaignRun {
  runId: string;
  campaignId: string;
  status: 'COMPLETED' | 'KILLED_AUTO' | 'KILLED_MANUAL';
  /**
   * Human-readable explanation of the terminal status — why the run ended the
   * way it did. Always set for a kill (auto/manual) so the UI never shows a bare
   * "Auto-killed" badge with no cause. Undefined for a clean completion.
   */
  statusDetail?: string;
  /**
   * The load engine that ACTUALLY ran this campaign — e.g. 'builtin-http',
   * 'vegeta', 'k6'. This can differ from the campaign's configured `agent` when
   * a high-rate step is auto-routed off the built-in engine (see app.ts /
   * engine-route.ts), so it is the ground truth for "which engine measured this
   * run". Stamped at settle time; the report/drawer surface it. Absent on runs
   * created before this was recorded.
   */
  engine?: string;
  generator: LoadTestResult;
  probe: ProbeMetrics;
  /**
   * The legit probe read the target as unavailable while the generator was
   * getting a strong majority of successful responses from it — i.e. the probe
   * lost the connection race to the flood, not a target outage (PF1). When true,
   * the WRS availability was derived from the generator's success ratio, not the
   * probe's, and the run was NOT auto-killed on the false unavailability.
   */
  probeContended?: boolean;
  wrs: WrsBreakdown;
  /** Inferred protection posture (WAF/CDN/rate-limit/LB) from the probe. */
  posture?: PostureReport;
  /** SLO verdict against the campaign's acceptance criteria, when set. */
  acceptance?: AcceptanceResult;
  /** Per-second time-series captured during the run (rps, errors, availability). */
  timeline?: RunSample[];
  /** Source of the detection/mitigation timings when measured (e.g. 'mock', 'scrubbing'). */
  protectionSource?: string;
  /**
   * Real protection timings reported by a configured source (WAF / scrubbing /
   * cloud DDoS). Present only when a source answered — then the WRS is NOT
   * estimated. detectionTimeSec = TTD, mitigationTimeSec = TTM.
   */
  protection?: { source?: string; detectionTimeSec: number; mitigationTimeSec: number };
  /** Nominal metrics captured before the ramp (legitimate traffic only). */
  baseline?: BaselineMetrics;
  /** Under-load degradation vs. the baseline. */
  baselineDelta?: BaselineDelta;
  /** Host-side counters of the target during the run (when a source is configured). */
  targetTelemetry?: TargetSample[];
  /**
   * Independent reference vantage (I2): a second endpoint polled alongside the
   * target probe with no kill authority, used to attribute an outage. Present
   * only when the campaign set a `referenceUrl`.
   *   • targetAttributed = true  → the target degraded while the reference held,
   *     so the impact is the target's (a trustworthy auto-kill / low WRS).
   *   • targetAttributed = false → both degraded together, so the measurement is
   *     inconclusive: the fault may be network-side or our own egress, not the
   *     target. The run's verdict/statusDetail says so.
   */
  reference?: {
    url: string;
    samples: number;
    available: number;
    availPct: number;
    targetAttributed: boolean;
  };
  /**
   * Measurement confidence — whether the generator host itself may have been the
   * bottleneck (hard-stopped, or high event-loop lag during the run). When
   * `degraded`, the WRS is flagged in the UI/report as possibly understated.
   * Computed at settle time in `app.ts` (which has the live event-loop lag).
   */
  confidence?: RunConfidence;
  /**
   * Protection absorption for this run (configured → offered → origin RPS, and
   * the fraction the target edge absorbed). Computed at settle time; read by the
   * report and the in-app absorption widget so all surfaces agree.
   */
  absorption?: Absorption;
  /**
   * Bilateral corroboration (I1): our inferred absorption vs the edge's own
   * reported blocked/seen. Present only when an edge-absorption source answered.
   */
  edgeCorroboration?: AbsorptionCorroboration;
}

/**
 * Executes an approved campaign: runs the bounded HTTP generator and the
 * legitimate probe in parallel, under the control of a kill switch
 * (auto/manual/time-based). At the end, aggregates the metrics and computes the
 * WRS.
 *
 * `killSwitch` is provided by the caller to allow manual stop (SOC/NOC) during
 * execution.
 */
export async function executeCampaign(
  campaign: Campaign,
  allowedHosts: string[],
  killSwitch: KillSwitch,
  onProgress?: (p: LoadProgress) => void,
  agent: AttackAgent = new BuiltinHttpAgent(),
  protection: ProtectionProvider = noopProtectionProvider,
  captureBaselineFn: CaptureBaseline = captureBaseline,
  telemetry: TargetTelemetryProvider = noopTargetTelemetryProvider,
): Promise<CampaignRun> {
  // EPIC B2: capture the nominal baseline (legitimate traffic only) BEFORE the
  // ramp and before the timeout starts, so it doesn't eat into the load window.
  const baseline = await captureBaselineFn(campaign.probeUrl, killSwitch.signal).catch(
    () => undefined,
  );

  // Kill switch level 3: absolute time-based timeout.
  const timeoutTimer = setTimeout(
    () => killSwitch.trigger('TIMEOUT'),
    campaign.maxDurationSec * 1000,
  );

  // Probe/kill-switch thresholds are centralised and env-tunable (config/limits).
  const probeLimits = probeLimitsFromEnv();
  const probe = new Probe(
    campaign.probeUrl,
    killSwitch,
    probeLimits.intervalMs,
    probeLimits.timeoutMs,
    probeLimits,
  );
  // Corroboration signal for the probe's auto-kill: true while the load
  // generator is currently landing successful responses on the same target — in
  // which case a probe "unavailable" is contention (the probe losing the race to
  // the flood), NOT a target outage, so the probe must not auto-kill on it.
  // Updated once a second in the ticker below from the generator's success delta.
  let genRecentlyOk = false;
  probe.watchGenerator(() => genRecentlyOk);

  // Optional independent reference vantage (I2): polled in parallel with its OWN
  // kill switch so its availability never stops the run — it only informs
  // outage attribution at settle. Stopped as soon as the run ends.
  const referenceKill = new KillSwitch();
  const referenceProbe = campaign.referenceUrl
    ? new Probe(
        campaign.referenceUrl,
        referenceKill,
        probeLimits.intervalMs,
        probeLimits.timeoutMs,
        probeLimits,
      )
    : undefined;

  const genConfig: LoadTestConfig = {
    url: campaign.target,
    method: campaign.vector === 'http-post' ? 'POST' : 'GET',
    headers: {
      // Mandatory traffic tagging (TSD §5.2): every request is traceable.
      'X-WEDOS-TEST': `${campaign.id}:${Date.now()}`,
      ...campaign.headers,
    },
    body: campaign.vector === 'http-post' ? campaign.body : undefined,
    concurrency: campaign.concurrency,
    durationSec: campaign.maxDurationSec,
    maxRps: campaign.maxRps,
    phases: campaign.scenario,
    flow: campaign.flow,
    endpoints: campaign.endpoints,
    userAgents: campaign.userAgents,
    dataset: campaign.dataset,
    assertion: campaign.assertion,
    cacheBust: campaign.cacheBust,
    noKeepAlive: campaign.noKeepAlive,
    slowloris: campaign.vector === 'http-slowloris',
    authorized: campaign.authorized,
  };

  // Emit live progress once a second for EVERY engine: elapsed time plus a live
  // probe snapshot. The generator's own counters (only reported by the built-in
  // engine) are merged in when available; external engines still get the
  // elapsed bar and the probe health so a run is never a silent black box.
  let gen: LoadProgress | undefined;
  let lastGenOk = 0;
  const timeline: RunSample[] = [];
  // EPIC B1: host-side counters of the target, pulled once a second when a
  // telemetry source is configured, on the same clock as the timeline.
  const targetSeries: TargetSample[] = [];
  let telemetryInFlight = false;
  const startedMs = Date.now();
  const ticker = setInterval(() => {
    if (telemetry.configured && !telemetryInFlight && targetSeries.length < MAX_RUN_SAMPLES) {
      telemetryInFlight = true;
      void telemetry
        .sample({ campaignId: campaign.id, target: campaign.target })
        .then((s) => {
          if (s) targetSeries.push(s);
        })
        .catch(() => undefined)
        .finally(() => {
          telemetryInFlight = false;
        });
    }
    const pm = probe.metrics();
    // Generator health this tick: did it land new successful responses? If so the
    // target is provably serving, so the probe must not auto-kill on a contended
    // "unavailable" (see probe.watchGenerator). Stops being true the moment the
    // generator's successes stall (the target genuinely went down).
    const okNow = gen?.successful ?? 0;
    genRecentlyOk = okNow - lastGenOk >= 5;
    lastGenOk = okNow;
    const elapsedSec = Number(((Date.now() - startedMs) / 1000).toFixed(1));
    // Capture the per-second series (persisted with the run) for EVERY engine,
    // independently of whether a live consumer is attached.
    if (timeline.length < MAX_RUN_SAMPLES) {
      timeline.push({
        t: elapsedSec,
        rps: gen?.actualRps ?? 0,
        sent: gen?.sent ?? 0,
        failed: gen?.failed ?? 0,
        probe5xx: pm.errorRate5xx,
        availPct: pm.samples ? Number(((pm.available / pm.samples) * 100).toFixed(1)) : 100,
      });
    }
    onProgress?.({
      sent: gen?.sent ?? 0,
      successful: gen?.successful ?? 0,
      failed: gen?.failed ?? 0,
      actualRps: gen?.actualRps ?? 0,
      elapsedSec,
      // Forward the engine's live latency/status snapshot when the built-in
      // generator reports them (external engines leave them undefined).
      latencyMs: gen?.latencyMs,
      statusCounts: gen?.statusCounts,
      // Rolling window (last 60s) of the per-second series for a live sparkline.
      // The full series is still persisted with the finished run.
      timeline: timeline.slice(-60),
      // Probe health streamed live: its own latency percentiles and the
      // graduated verdict, so the operator sees a 'degraded' target before any
      // hard auto-kill — not only after the run settles.
      probe: {
        samples: pm.samples,
        available: pm.available,
        errorRate5xx: pm.errorRate5xx,
        latencyMs: pm.latencyMs,
        health: pm.health,
      },
    });
  }, 1000);
  if (typeof ticker.unref === 'function') ticker.unref();

  let generator: LoadTestResult;
  try {
    // Hard wall-clock bound: the probe (and thus this Promise.all) must always
    // terminate near the cap, even if the kill switch never fires — a run can
    // never hang open past maxDurationSec + a small grace. The load engine
    // self-bounds on the same clock via its own deadline.
    const probeHardDeadlineMs = startedMs + campaign.maxDurationSec * 1000 + 20_000;
    // The reference probe runs alongside but is NOT awaited by the run's
    // completion — it's stopped in the finally so it can't hold the run open.
    const referenceDone = referenceProbe?.run(probeHardDeadlineMs);
    [generator] = await Promise.all([
      agent.run(genConfig, allowedHosts, killSwitch.signal, (p) => {
        gen = p;
      }),
      probe.run(probeHardDeadlineMs),
    ]);
    referenceKill.trigger('KILLED_MANUAL'); // stop the reference probe now the run has ended
    await referenceDone?.catch(() => undefined);
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(ticker);
  }

  const probeMetrics = probe.metrics();
  const referenceMetrics = referenceProbe?.metrics();

  // Probe-contention correction (PF1): the probe can read the target as
  // (near-)unavailable while the generator got a strong majority of successful
  // responses from the SAME target — the target WAS serving and the probe just
  // lost the connection race to the flood. In that case the probe's availability
  // is a false negative, so use the generator's own success ratio (a valid
  // measure of the target's availability under load) as the availability truth.
  const genTotal = generator.totalRequests;
  const genSuccessRatio = genTotal > 0 ? generator.successful / genTotal : 0;
  const rawProbeAvail = probeMetrics.samples ? probeMetrics.available / probeMetrics.samples : 1;
  const probeContended =
    probeMetrics.samples > 0 && rawProbeAvail < 0.2 && genTotal >= 100 && genSuccessRatio >= 0.8;
  // Detection/mitigation: with no protection integration, we derive
  // conservative estimates from the probe's measurements. These values can be
  // replaced by the real timings reported by WEDOS Protection.
  const availabilityRatio = probeContended ? genSuccessRatio : rawProbeAvail;
  // Real detection/mitigation timings from the protection layer, when a source
  // is configured; otherwise conservative estimates (WRS marked as estimated).
  const measured = await protection
    .measure({
      campaignId: campaign.id,
      target: campaign.target,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: new Date().toISOString(),
    })
    .catch(() => null);
  // When no protection source reports real timings, fall back to conservative
  // named estimates (config/limits) — worse ones when the probe had to auto-kill.
  const estimate =
    killSwitch.reason === 'KILLED_AUTO' ? ESTIMATED_TIMINGS.autoKill : ESTIMATED_TIMINGS.held;
  const wrs = computeWrs({
    detectionTimeSec: measured ? measured.detectionTimeSec : estimate.detectionTimeSec,
    mitigationTimeSec: measured ? measured.mitigationTimeSec : estimate.mitigationTimeSec,
    // Under probe contention, the generator's own success counts are the truthful
    // legitimate-availability signal (the probe's are a false negative).
    legitimateSuccessful: probeContended ? generator.successful : probeMetrics.successful,
    legitimateTotal: probeContended ? genTotal : probeMetrics.samples,
    adjacentImpactScore: Math.round((1 - availabilityRatio) * 100),
  });
  // Estimated unless a protection source reported the real timings.
  wrs.estimated = !measured;

  const status: CampaignRun['status'] =
    killSwitch.reason === 'KILLED_MANUAL'
      ? 'KILLED_MANUAL'
      : killSwitch.reason === 'KILLED_AUTO'
        ? 'KILLED_AUTO'
        : 'COMPLETED';

  // Explain a kill so the UI never shows a bare status with no cause. The
  // auto-kill trips after ≥30 s of consecutive probe unavailability; report the
  // measured availability that drove it.
  const availPct = probeMetrics.samples
    ? Number(((probeMetrics.available / probeMetrics.samples) * 100).toFixed(1))
    : 100;

  // Outage attribution from the independent reference vantage (I2), when set.
  // The target is attributed the impact when it fared clearly worse than the
  // reference; if both fell together the measurement is inconclusive.
  const ATTRIBUTION_MARGIN_PCT = 20;
  const reference =
    referenceMetrics && campaign.referenceUrl
      ? (() => {
          const refAvailPct = referenceMetrics.samples
            ? Number(((referenceMetrics.available / referenceMetrics.samples) * 100).toFixed(1))
            : 100;
          return {
            url: campaign.referenceUrl,
            samples: referenceMetrics.samples,
            available: referenceMetrics.available,
            availPct: refAvailPct,
            targetAttributed: refAvailPct - availPct >= ATTRIBUTION_MARGIN_PCT,
          };
        })()
      : undefined;

  let statusDetail: string | undefined =
    status === 'KILLED_AUTO'
      ? `Auto-killed: the legitimate probe found the target unavailable for ≥30 s ` +
        `(availability ${availPct}% over ${probeMetrics.samples} checks). The kill ` +
        `switch stopped the run to protect the target.`
      : status === 'KILLED_MANUAL'
        ? `Manually stopped by an operator during the run.`
        : undefined;
  // Fold the reference verdict into the explanation for a kill, so an operator
  // reading the status knows whether to trust it as target-specific.
  if (statusDetail && reference) {
    statusDetail += reference.targetAttributed
      ? ` The independent reference vantage stayed reachable (${reference.availPct}% available), corroborating that the impact was target-specific.`
      : ` Note: the independent reference vantage was also unreachable (${reference.availPct}% available), so this may be a network-side or local-egress issue rather than the target — treat the verdict as inconclusive.`;
  }

  const underLoadAvailPct = probeMetrics.samples
    ? (probeMetrics.available / probeMetrics.samples) * 100
    : 100;
  const baselineDelta = baseline
    ? computeBaselineDelta(baseline, {
        availabilityPct: underLoadAvailPct,
        latencyMs: { p50: probeMetrics.latencyMs.p50, p95: probeMetrics.latencyMs.p95 },
      })
    : undefined;

  const total = generator.totalRequests;
  const checked = generator.assertionsChecked ?? 0;
  const acceptance =
    evaluateAcceptance(campaign.acceptance, {
      p95Ms: generator.latencyMs.p95,
      errorRatePct: total > 0 ? (generator.failed / total) * 100 : 0,
      availabilityPct: probeMetrics.samples
        ? (probeMetrics.available / probeMetrics.samples) * 100
        : 100,
      wrs: wrs.wrs,
      assertionFailurePct: checked > 0 ? ((generator.assertionFailures ?? 0) / checked) * 100 : 0,
    }) ?? undefined;

  return {
    runId: generator.id,
    campaignId: campaign.id,
    status,
    statusDetail,
    generator,
    probe: probeMetrics,
    probeContended,
    wrs,
    posture: probe.posture(),
    acceptance,
    timeline,
    protectionSource: measured?.source,
    protection: measured
      ? {
          source: measured.source,
          detectionTimeSec: measured.detectionTimeSec,
          mitigationTimeSec: measured.mitigationTimeSec,
        }
      : undefined,
    baseline,
    baselineDelta,
    targetTelemetry: targetSeries.length ? targetSeries : undefined,
    reference,
  };
}
