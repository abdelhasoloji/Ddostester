import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';

/** Prometheus exposition (text format 0.0.4), no dependency. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function renderMetrics(campaigns: Campaign[], runsCount: number): string {
  const byStatus = new Map<string, number>();
  for (const c of campaigns) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);

  // Last WRS per target: campaigns sorted newest to oldest.
  const lastWrs = new Map<string, number>();
  for (const c of campaigns) {
    let host = c.target;
    try {
      host = new URL(c.target).hostname;
    } catch {
      /* keep the raw value */
    }
    if (c.wrs && !lastWrs.has(host)) lastWrs.set(host, c.wrs.wrs);
  }

  const lines: string[] = [];
  lines.push('# HELP shieldtest_campaigns Number of campaigns by status');
  lines.push('# TYPE shieldtest_campaigns gauge');
  for (const [status, n] of byStatus) {
    lines.push(`shieldtest_campaigns{status="${escapeLabel(status)}"} ${n}`);
  }
  lines.push('# HELP shieldtest_runs_total Total number of recorded runs');
  lines.push('# TYPE shieldtest_runs_total counter');
  lines.push(`shieldtest_runs_total ${runsCount}`);
  lines.push('# HELP shieldtest_wrs_last Last WRS per target');
  lines.push('# TYPE shieldtest_wrs_last gauge');
  for (const [target, wrs] of lastWrs) {
    lines.push(`shieldtest_wrs_last{target="${escapeLabel(target)}"} ${wrs}`);
  }
  return lines.join('\n') + '\n';
}

/** Final received fleet evidence, one latest run per target; gaps are never zero-filled. */
export function renderFleetMetrics(runs: CampaignRun[]): string {
  const latest = new Map<string, CampaignRun>();
  for (const run of runs) {
    if (!run.generator.fleet || !Number.isFinite(Date.parse(run.generator.finishedAt))) continue;
    let target: string;
    try {
      const url = new URL(run.generator.config.url);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      target = url.origin;
    } catch {
      continue;
    }
    const previous = latest.get(target);
    if (
      !previous ||
      Date.parse(run.generator.finishedAt) > Date.parse(previous.generator.finishedAt) ||
      (Date.parse(run.generator.finishedAt) === Date.parse(previous.generator.finishedAt) &&
        run.runId > previous.runId)
    )
      latest.set(target, run);
  }
  const definitions = {
    finished_timestamp_seconds:
      'Finish time of the latest recorded fleet run, not scrape freshness',
    measurement_complete: 'Recorded fleet completeness: 1 complete, 0 incomplete',
    coverage_known: 'Whether coherent received-final-results coverage was recorded',
    reported_agents: 'Agents with received final reports in the latest fleet run',
    expected_agents: 'Recorded expected agents in received-final-results coverage',
    reported_requests: 'Requests in received fleet results; incomplete fleets are only a subset',
  };
  const lines = Object.entries(definitions).flatMap(([suffix, description]) => [
    `# HELP shieldtest_fleet_${suffix}_last ${description}`,
    `# TYPE shieldtest_fleet_${suffix}_last gauge`,
  ]);
  for (const [target, run] of latest) {
    const fleet = run.generator.fleet!;
    const emit = (suffix: keyof typeof definitions, value: number) =>
      lines.push(`shieldtest_fleet_${suffix}_last{target="${escapeLabel(target)}"} ${value}`);
    emit('finished_timestamp_seconds', Date.parse(run.generator.finishedAt) / 1000);
    if (typeof fleet.measurementComplete === 'boolean')
      emit('measurement_complete', Number(fleet.measurementComplete));
    const coverage = fleet.counterCoverage;
    const known =
      coverage?.scope === 'received-final-results-only' &&
      Number.isSafeInteger(coverage.reportedAgents) &&
      Number.isSafeInteger(coverage.expectedAgents) &&
      coverage.reportedAgents >= 0 &&
      coverage.expectedAgents > 0 &&
      coverage.reportedAgents <= coverage.expectedAgents &&
      coverage.reportedAgents === fleet.shards.filter((shard) => shard.result?.generator).length;
    emit('coverage_known', Number(known));
    if (known) {
      emit('reported_agents', coverage!.reportedAgents);
      emit('expected_agents', coverage!.expectedAgents);
    }
    if (Number.isSafeInteger(run.generator.totalRequests) && run.generator.totalRequests >= 0)
      emit('reported_requests', run.generator.totalRequests);
  }
  return lines.join('\n') + '\n';
}
