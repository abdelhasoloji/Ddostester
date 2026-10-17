import type { CampaignRun } from '../campaigns/runner.js';
import { fleetCounterCoverage } from '../fleet/summary.js';
import { toCsv } from '../../util/csv.js';
import { observedAvailability } from './measurements.js';

/** One row per run: aggregated metrics for spreadsheets / SIEM (RPT-03). */
export function runsSummaryCsv(runs: CampaignRun[]): string {
  const headers = [
    'runId',
    'campaignId',
    'status',
    'startedAt',
    'finishedAt',
    'requests',
    'successful',
    'failed',
    'actualRps',
    'latencyP95Ms',
    'probeSamples',
    'probeAvailable',
    'probe5xxPct',
    'wrs',
    'wrsLevel',
    'wrsEstimated',
    'probeDiagnosticSamples',
    'probeEventLoopDelayPeakMs',
    'probeThrottledFractionPeak',
    'fleetReportedAgents',
    'fleetExpectedAgents',
    'reportedRequests',
    'counterScope',
    'probeRecentEventLoopDelayPeakMs',
    'probeEventLoopDiagnosticSamples',
    'baselineDiagnosticSamples',
    'baselineDiagnosticTotalSamples',
    'baselineRecentEventLoopDelayPeakMs',
    'baselineThrottledFractionPeak',
    'recoveryBeforeRunAvailable',
    'recoveryBeforeRunVerified',
    'recoveryBeforeRunChecks',
    'recoveryBeforeRunWaitedMs',
    'recoveryBeforeRunDiagnosticSamples',
    'recoveryBeforeRunRecentEventLoopPeakMs',
    'fleetFirstGeneratorStartDelayMs',
    'fleetLastGeneratorStartDelayMs',
    'fleetStartTimestampAgents',
    'iotProfile',
    'iotSeed',
    'iotDeviceIndex',
    'finalizedRequests',
    'unfinalizedRequests',
    'generatorLatencyMethod',
    'generatorLatencySampleCount',
    'measurementUnit',
    'connectionsOpened',
    'connectionsClosed',
  ];
  const rows = runs.map((r) => {
    const connections =
      r.generator.config?.slowloris === true ||
      r.timeline?.some((s) => s.sampleUnit === 'connections');
    const coverage = r.generator.fleet ? fleetCounterCoverage(r.generator.fleet.shards) : undefined;
    const partial = coverage && coverage.reportedAgents < coverage.expectedAgents;
    return [
      r.runId,
      r.campaignId,
      r.status,
      r.generator.startedAt,
      r.generator.finishedAt,
      partial || connections ? undefined : r.generator.totalRequests,
      partial || connections ? undefined : r.generator.successful,
      partial || connections ? undefined : r.generator.failed,
      partial || connections ? undefined : r.generator.actualRps,
      partial || connections || r.generator.latencySampleCount === 0
        ? undefined
        : r.generator.latencyMs.p95,
      r.probe.samples,
      r.probe.available,
      observedAvailability(r) === null ? undefined : r.probe.errorRate5xx,
      r.wrs.wrs,
      r.wrs.level,
      r.wrs.estimated ? 'yes' : 'no',
      r.probe.quality?.measuredSamples,
      r.probe.quality?.peakEventLoopDelayMs,
      r.probe.quality?.peakThrottledFraction,
      coverage?.reportedAgents,
      coverage?.expectedAgents,
      coverage ? r.generator.totalRequests : undefined,
      coverage?.scope,
      r.probe.quality?.peakRecentEventLoopDelayMs,
      r.probe.quality?.eventLoopMeasuredSamples,
      r.baseline?.quality?.measuredSamples,
      r.baseline?.quality?.totalSamples,
      r.baseline?.quality?.peakRecentEventLoopDelayMs,
      r.baseline?.quality?.peakThrottledFraction,
      r.recoveryBeforeRun?.available,
      r.recoveryBeforeRun?.verified,
      r.recoveryBeforeRun?.checks,
      r.recoveryBeforeRun?.waitedMs,
      r.recoveryBeforeRun?.quality?.measuredSamples,
      r.recoveryBeforeRun?.quality?.peakRecentEventLoopDelayMs,
      r.generator.fleet?.startup?.firstGeneratorStartDelayMs,
      r.generator.fleet?.startup?.lastGeneratorStartDelayMs,
      r.generator.fleet?.startup?.reportedAgents,
      r.generator.config?.iotProfile?.id,
      r.generator.config?.iotProfile?.seed,
      r.generator.config?.iotProfile?.deviceIndex,
      r.generator.finalizedRequests,
      r.generator.unfinalizedRequests,
      r.generator.latencyMethod,
      r.generator.latencySampleCount,
      connections ? 'connections' : 'requests',
      connections ? r.generator.totalRequests : undefined,
      connections ? r.generator.failed : undefined,
    ];
  });
  return toCsv(headers, rows);
}

/** Per-second time-series of one run (rps, errors, availability). */
export function runTimelineCsv(run: CampaignRun): string {
  const headers = [
    't',
    'rps',
    'sent',
    'failed',
    'probe5xxPct',
    'availPct',
    'generatorObserved',
    'successful',
    'probeSamples',
    'probeP95Ms',
    'sampleUnit',
  ];
  const rows = (run.timeline ?? []).map((s) => [
    s.t,
    s.generatorObserved === false || s.sampleUnit === 'connections' ? undefined : s.rps,
    s.generatorObserved === false ? undefined : s.sent,
    s.generatorObserved === false ? undefined : s.failed,
    observedAvailability(run) === null || s.probeSamples === 0 ? undefined : s.probe5xx,
    observedAvailability(run) === null || s.probeSamples === 0 ? undefined : s.availPct,
    s.generatorObserved,
    s.generatorObserved === false || s.sampleUnit === 'connections' ? undefined : s.successful,
    s.probeSamples,
    observedAvailability(run) === null || s.probeSamples === 0 ? undefined : s.probeP95,
    s.sampleUnit,
  ]);
  return toCsv(headers, rows);
}
