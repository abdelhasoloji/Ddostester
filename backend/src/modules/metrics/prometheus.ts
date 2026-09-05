import type { Campaign } from '../campaigns/model.js';

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
