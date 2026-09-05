import { runLoadTest } from '../../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../../engine/types.js';
import { KillSwitch, Probe } from '../probe/probe.js';
import type { ProbeMetrics } from '../probe/probe.js';
import { computeWrs } from '../wrs/scoring.js';
import type { WrsBreakdown } from '../wrs/scoring.js';
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
 * Exécute une campagne approuvée : lance en parallèle le générateur HTTP borné
 * et la sonde légitime, sous le contrôle d'un kill switch (auto/manuel/temporel).
 * À la fin, agrège les métriques et calcule le WRS.
 *
 * `killSwitch` est fourni par l'appelant pour permettre l'arrêt manuel (SOC/NOC)
 * en cours d'exécution.
 */
export async function executeCampaign(
  campaign: Campaign,
  allowedHosts: string[],
  killSwitch: KillSwitch,
): Promise<CampaignRun> {
  // Niveau 3 du kill switch : timeout temporel absolu.
  const timeoutTimer = setTimeout(
    () => killSwitch.trigger('TIMEOUT'),
    campaign.maxDurationSec * 1000,
  );

  const probe = new Probe(campaign.probeUrl, killSwitch);

  const genConfig: LoadTestConfig = {
    url: campaign.target,
    method: campaign.vector === 'http-post' ? 'POST' : 'GET',
    headers: {
      // Marquage de trafic obligatoire (TSD §5.2) : chaque requête est traçable.
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
    runLoadTest(genConfig, allowedHosts, killSwitch.signal),
    probe.run(),
  ]);
  clearTimeout(timeoutTimer);

  const probeMetrics = probe.metrics();

  // Détection/mitigation : en l'absence d'intégration avec la protection, on
  // dérive des estimations conservatrices des mesures de la sonde. Ces valeurs
  // peuvent être remplacées par les temps réels remontés par WEDOS Protection.
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

  const status: CampaignRun['status'] =
    killSwitch.reason === 'KILLED_MANUAL'
      ? 'KILLED_MANUAL'
      : killSwitch.reason === 'KILLED_AUTO'
        ? 'KILLED_AUTO'
        : 'COMPLETED';

  return { runId: generator.id, campaignId: campaign.id, status, generator, probe: probeMetrics, wrs };
}
