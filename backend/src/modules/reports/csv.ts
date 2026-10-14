import type { CampaignRun } from '../campaigns/runner.js';
import { fleetCounterCoverage } from '../fleet/summary.js';
import { toCsv } from '../../util/csv.js';

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
  ];
  const rows = runs.map((r) => {
    const coverage = r.generator.fleet ? fleetCounterCoverage(r.generator.fleet.shards) : undefined;
    const partial = coverage && coverage.reportedAgents < coverage.expectedAgents;
    return [
      r.runId,
      r.campaignId,
      r.status,
      r.generator.startedAt,
      r.generator.finishedAt,
      partial ? undefined : r.generator.totalRequests,
      partial ? undefined : r.generator.successful,
      partial ? undefined : r.generator.failed,
      partial ? undefined : r.generator.actualRps,
      partial || r.generator.latencySampleCount === 0 ? undefined : r.generator.latencyMs.p95,
      r.probe.samples,
      r.probe.available,
      r.probe.errorRate5xx,
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
    ];
  });
  return toCsv(headers, rows);
}

/** Per-second time-series of one run (rps, errors, availability). */
export function runTimelineCsv(run: CampaignRun): string {
  const headers = ['t', 'rps', 'sent', 'failed', 'probe5xxPct', 'availPct'];
  const rows = (run.timeline ?? []).map((s) => [
    s.t,
    s.rps,
    s.sent,
    s.failed,
    s.probe5xx,
    s.availPct,
  ]);
  return toCsv(headers, rows);
}
