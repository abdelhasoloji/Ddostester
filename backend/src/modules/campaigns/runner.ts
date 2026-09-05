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
import type { Campaign } from './model.js';

export interface CampaignRun {
  runId: string;
  campaignId: string;
  status: 'COMPLETED' | 'KILLED_AUTO' | 'KILLED_MANUAL';
  generator: LoadTestResult;
  probe: ProbeMetrics;
  wrs: WrsBreakdown;
  /** Inferred protection posture (WAF/CDN/rate-limit/LB) from the probe. */
  posture?: PostureReport;
  /** SLO verdict against the campaign's acceptance criteria, when set. */
  acceptance?: AcceptanceResult;
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
): Promise<CampaignRun> {
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
    assertion: campaign.assertion,
    authorized: campaign.authorized,
  };

  // Emit live progress once a second for EVERY engine: elapsed time plus a live
  // probe snapshot. The generator's own counters (only reported by the built-in
  // engine) are merged in when available; external engines still get the
  // elapsed bar and the probe health so a run is never a silent black box.
  let gen: LoadProgress | undefined;
  const startedMs = Date.now();
  const ticker = setInterval(() => {
    if (!onProgress) return;
    const pm = probe.metrics();
    onProgress({
      sent: gen?.sent ?? 0,
      successful: gen?.successful ?? 0,
      failed: gen?.failed ?? 0,
      actualRps: gen?.actualRps ?? 0,
      elapsedSec: Number(((Date.now() - startedMs) / 1000).toFixed(1)),
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
    generator,
    probe: probeMetrics,
    wrs,
    posture: probe.posture(),
    acceptance,
  };
}
