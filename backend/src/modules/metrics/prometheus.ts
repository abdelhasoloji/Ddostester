import { assessDrs } from '../drs/scoring.js';
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
  return lines.join('\n') + '\n' + renderDrsMetrics(campaigns);
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

/** Frozen DRS revisions: assessment stays authoritative; missing scores remain absent. */
export function renderDrsMetrics(campaigns: Campaign[]): string {
  const lines: string[] = [];
  const definitions: Record<string, string> = {
    revision_info: 'Frozen reference and current workflow phase for each stored DRS revision',
    assessment_available: 'Whether the application could verify and assess this frozen revision',
    assessment_info: 'Application assessment status; simulation is never measured resilience',
    score: 'Application score when available; inspect mode and assessment status',
    vectors: 'Application vector coverage by level; excluded is a subset of unknown',
  };
  for (const [suffix, description] of Object.entries(definitions)) {
    lines.push(`# HELP shieldtest_drs_${suffix} ${description}`);
    lines.push(`# TYPE shieldtest_drs_${suffix} gauge`);
  }
  const labels = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
      .join(',');
  for (const campaign of campaigns) {
    for (const revision of campaign.drsDocument?.revisions ?? []) {
      const base = {
        campaign_id: campaign.id,
        revision: String(revision.number),
        revision_id: revision.id,
        mode: revision.plan.mode,
      };
      const emit = (name: string, value: number, extra: Record<string, string> = {}) => {
        if (Number.isFinite(value))
          lines.push(`shieldtest_drs_${name}{${labels({ ...base, ...extra })}} ${value}`);
      };
      emit('revision_info', 1, {
        state: revision.state,
        standard: revision.reference.standardVersion,
        catalogue_hash: revision.reference.catalogueHash,
        engine: revision.reference.engineVersion,
        interpretation: revision.reference.interpretationProfile,
        plan_hash: revision.planHash ?? '',
      });
      if (!revision.planHash) continue;
      try {
        const assessment = assessDrs(revision);
        emit('assessment_available', 1);
        emit('assessment_info', 1, {
          status: assessment.status,
          outcome: assessment.terminalOutcome,
          terminal_level: String(assessment.terminalLevel ?? ''),
          finalized: String(Boolean(revision.finalizedAt)),
        });
        if (assessment.score !== null) emit('score', assessment.score);
        for (const level of assessment.levels) {
          for (const [coverage, value] of Object.entries({
            total: level.total,
            passed: level.passed,
            failed: level.failed,
            unknown: level.inconclusive,
            excluded: level.excluded,
          }))
            emit('vectors', value, { level: String(level.level), coverage });
        }
      } catch {
        // Integrity failures stay visible without making unrelated metrics unavailable.
        emit('assessment_available', 0);
      }
    }
  }
  return lines.join('\n') + '\n';
}
