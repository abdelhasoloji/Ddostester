import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';

/**
 * RPT-02 — Rapport de conformité agrégé (DORA / NIS2 / ISO 27001).
 * Agrège les exécutions sur une période : volume, statuts, WRS moyen/min,
 * couverture par cible. Purement analytique (aucun trafic généré).
 */
export interface ComplianceOptions {
  from?: string; // ISO
  to?: string; // ISO
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function renderComplianceHtml(
  campaigns: Campaign[],
  runs: CampaignRun[],
  opts: ComplianceOptions = {},
): string {
  const from = opts.from ? Date.parse(opts.from) : -Infinity;
  const to = opts.to ? Date.parse(opts.to) : Infinity;
  const targetOf = new Map(campaigns.map((c) => [c.id, c.target]));

  const inPeriod = runs.filter((r) => {
    const t = Date.parse(r.generator.finishedAt);
    return t >= from && t <= to;
  });

  const total = inPeriod.length;
  const byStatus = new Map<string, number>();
  const byLevel = new Map<string, number>();
  let wrsSum = 0;
  let wrsMin = Infinity;
  const perTarget = new Map<string, { n: number; sum: number; last: number }>();

  for (const r of inPeriod) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    byLevel.set(r.wrs.level, (byLevel.get(r.wrs.level) ?? 0) + 1);
    wrsSum += r.wrs.wrs;
    wrsMin = Math.min(wrsMin, r.wrs.wrs);
    let host = targetOf.get(r.campaignId) ?? '—';
    try {
      host = new URL(host).hostname;
    } catch {
      /* garde brut */
    }
    const agg = perTarget.get(host) ?? { n: 0, sum: 0, last: r.wrs.wrs };
    agg.n += 1;
    agg.sum += r.wrs.wrs;
    perTarget.set(host, agg);
  }

  const wrsAvg = total ? (wrsSum / total).toFixed(1) : '—';
  const wrsMinStr = total ? String(wrsMin) : '—';
  const worst = inPeriod.filter((r) => r.wrs.wrs < 70);

  const row = (k: string, v: string | number) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const period = `${opts.from ? esc(opts.from) : 'origine'} → ${opts.to ? esc(opts.to) : 'maintenant'}`;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Rapport de conformité — WEDOS ShieldTest</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:900px}
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #003484;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0}.wm{font-weight:800;color:#003484}
 h2{color:#003484}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
 .muted{color:#666}
</style></head><body>
<div class="brand">
 <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4aa0"/><stop offset="1" stop-color="#003484"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
 <h1><span class="wm">WEDOS ShieldTest</span> — Rapport de conformité (DORA / NIS2 / ISO 27001)</h1>
</div>
<p class="muted">Période : ${period} · généré le ${new Date().toISOString()}</p>

<h2>Synthèse</h2>
<table>
 ${row('Exécutions sur la période', total)}
 ${row('WRS moyen', wrsAvg)}
 ${row('WRS minimum', wrsMinStr)}
 ${row('Campagnes en échec de résilience (WRS &lt; 70)', worst.length)}
</table>

<h2>Répartition par statut</h2>
<table>${[...byStatus].map(([k, v]) => row(k, v)).join('') || row('—', 0)}</table>

<h2>Répartition par niveau WRS</h2>
<table>${[...byLevel].map(([k, v]) => row(k, v)).join('') || row('—', 0)}</table>

<h2>Couverture par cible</h2>
<table><tr><th>Cible</th><th>Exécutions</th><th>WRS moyen</th></tr>
${[...perTarget].map(([t, a]) => `<tr><td>${esc(t)}</td><td>${a.n}</td><td>${(a.sum / a.n).toFixed(1)}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
</table>

<p class="muted">Preuve de résilience générée automatiquement. Générateur HTTP borné —
aucun vecteur volumétrique. Usage interne WEDOS.</p>
</body></html>`;
}
