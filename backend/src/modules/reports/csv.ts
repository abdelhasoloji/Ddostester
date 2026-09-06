import type { CampaignRun } from '../campaigns/runner.js';
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
  ];
  const rows = runs.map((r) => [
    r.runId,
    r.campaignId,
    r.status,
    r.generator.startedAt,
    r.generator.finishedAt,
    r.generator.totalRequests,
    r.generator.successful,
    r.generator.failed,
    r.generator.actualRps,
    r.generator.latencyMs.p95,
    r.probe.samples,
    r.probe.available,
    r.probe.errorRate5xx,
    r.wrs.wrs,
    r.wrs.level,
    r.wrs.estimated ? 'yes' : 'no',
  ]);
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
