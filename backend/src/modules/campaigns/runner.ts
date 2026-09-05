import type { LoadTestConfig, LoadTestResult } from '../../engine/types.js';
import { KillSwitch, Probe } from '../probe/probe.js';
import type { ProbeMetrics } from '../probe/probe.js';
import { computeWrs } from '../wrs/scoring.js';
import type { WrsBreakdown } from '../wrs/scoring.js';
import { BuiltinHttpAgent } from '../../agents/builtin.js';
import type { AttackAgent } from '../../agents/types.js';
import type { Campaign } from './model.js';

export interface CampaignRun {
  runId: string;
  campaignId: string;
  status: 'COMPLETED' | 'KILLED_AUTO' | 'KILLED_MANUAL';
  generator: LoadTestResult;
  probe: ProbeMetrics;
  wrs: WrsBreakdown;
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
  onProgress?: (p: import('../../engine/loadTest.js').LoadProgress) => void,
  agent: AttackAgent = new BuiltinHttpAgent(),
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
    authorized: campaign.authorized,
  };

  const [generator] = await Promise.all([
    agent.run(genConfig, allowedHosts, killSwitch.signal, onProgress),
    probe.run(),
  ]);
  clearTimeout(timeoutTimer);

  const probeMetrics = probe.metrics();

  // Detection/mitigation: with no protection integration, we derive
  // conservative estimates from the probe's measurements. These values can be
  // replaced by the real timings reported by WEDOS Protection.
  const availabilityRatio = probeMetrics.samples
    ? probeMetrics.available / probeMetrics.samples
    : 1;
  const wrs = computeWrs({
    detectionTimeSec: killSwitch.reason === 'KILLED_AUTO' ? 30 : 10,
    mitigationTimeSec: killSwitch.reason === 'KILLED_AUTO' ? 60 : 20,
    legitimateSuccessful: probeMetrics.successful,
    legitimateTotal: probeMetrics.samples,
    adjacentImpactScore: Math.round((1 - availabilityRatio) * 100),
  });
  // No protection integration here → Detection/Mitigation are estimated.
  wrs.estimated = true;

  const status: CampaignRun['status'] =
    killSwitch.reason === 'KILLED_MANUAL'
      ? 'KILLED_MANUAL'
      : killSwitch.reason === 'KILLED_AUTO'
        ? 'KILLED_AUTO'
        : 'COMPLETED';

  return {
    runId: generator.id,
    campaignId: campaign.id,
    status,
    generator,
    probe: probeMetrics,
    wrs,
  };
}
