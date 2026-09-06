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
  generator: LoadTestResult;
  probe: ProbeMetrics;
  wrs: WrsBreakdown;
  /** Inferred protection posture (WAF/CDN/rate-limit/LB) from the probe. */
  posture?: PostureReport;
  /** SLO verdict against the campaign's acceptance criteria, when set. */
  acceptance?: AcceptanceResult;
  /** Per-second time-series captured during the run (rps, errors, availability). */
  timeline?: RunSample[];
  /** Source of the detection/mitigation timings when measured (e.g. 'mock', 'scrubbing'). */
  protectionSource?: string;
  /** Nominal metrics captured before the ramp (legitimate traffic only). */
  baseline?: BaselineMetrics;
  /** Under-load degradation vs. the baseline. */
  baselineDelta?: BaselineDelta;
  /** Host-side counters of the target during the run (when a source is configured). */
  targetTelemetry?: TargetSample[];
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

  const probe = new Probe(campaign.probeUrl, killSwitch);

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
    authorized: campaign.authorized,
  };

  // Emit live progress once a second for EVERY engine: elapsed time plus a live
  // probe snapshot. The generator's own counters (only reported by the built-in
  // engine) are merged in when available; external engines still get the
  // elapsed bar and the probe health so a run is never a silent black box.
  let gen: LoadProgress | undefined;
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
      probe: { samples: pm.samples, available: pm.available, errorRate5xx: pm.errorRate5xx },
    });
  }, 1000);
  if (typeof ticker.unref === 'function') ticker.unref();

  let generator: LoadTestResult;
  try {
    [generator] = await Promise.all([
      agent.run(genConfig, allowedHosts, killSwitch.signal, (p) => {
        gen = p;
      }),
      probe.run(),
    ]);
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(ticker);
  }

  const probeMetrics = probe.metrics();

  // Detection/mitigation: with no protection integration, we derive
  // conservative estimates from the probe's measurements. These values can be
  // replaced by the real timings reported by WEDOS Protection.
  const availabilityRatio = probeMetrics.samples
    ? probeMetrics.available / probeMetrics.samples
    : 1;
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
  const wrs = computeWrs({
    detectionTimeSec: measured
      ? measured.detectionTimeSec
      : killSwitch.reason === 'KILLED_AUTO'
        ? 30
        : 10,
    mitigationTimeSec: measured
      ? measured.mitigationTimeSec
      : killSwitch.reason === 'KILLED_AUTO'
        ? 60
        : 20,
    legitimateSuccessful: probeMetrics.successful,
    legitimateTotal: probeMetrics.samples,
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
  const statusDetail: string | undefined =
    status === 'KILLED_AUTO'
      ? `Auto-killed: the legitimate probe found the target unavailable for ≥30 s ` +
        `(availability ${availPct}% over ${probeMetrics.samples} checks). The kill ` +
        `switch stopped the run to protect the target.`
      : status === 'KILLED_MANUAL'
        ? `Manually stopped by an operator during the run.`
        : undefined;

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
    wrs,
    posture: probe.posture(),
    acceptance,
    timeline,
    protectionSource: measured?.source,
    baseline,
    baselineDelta,
    targetTelemetry: targetSeries.length ? targetSeries : undefined,
  };
}
