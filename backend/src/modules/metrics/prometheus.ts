import type { Campaign } from '../campaigns/model.js';

/** Exposition Prometheus (format texte 0.0.4), sans dépendance. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function renderMetrics(campaigns: Campaign[], runsCount: number): string {
  const byStatus = new Map<string, number>();
  for (const c of campaigns) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);

  // Dernier WRS par cible : campaigns triées du plus récent au plus ancien.
  const lastWrs = new Map<string, number>();
  for (const c of campaigns) {
    let host = c.target;
    try {
      host = new URL(c.target).hostname;
    } catch {
      /* garde la valeur brute */
    }
    if (c.wrs && !lastWrs.has(host)) lastWrs.set(host, c.wrs.wrs);
  }

  const lines: string[] = [];
  lines.push('# HELP shieldtest_campaigns Nombre de campagnes par statut');
  lines.push('# TYPE shieldtest_campaigns gauge');
  for (const [status, n] of byStatus) {
    lines.push(`shieldtest_campaigns{status="${escapeLabel(status)}"} ${n}`);
  }
  lines.push('# HELP shieldtest_runs_total Nombre total d’exécutions enregistrées');
  lines.push('# TYPE shieldtest_runs_total counter');
  lines.push(`shieldtest_runs_total ${runsCount}`);
  lines.push('# HELP shieldtest_wrs_last Dernier WRS par cible');
  lines.push('# TYPE shieldtest_wrs_last gauge');
  for (const [target, wrs] of lastWrs) {
    lines.push(`shieldtest_wrs_last{target="${escapeLabel(target)}"} ${wrs}`);
  }
  return lines.join('\n') + '\n';
}
