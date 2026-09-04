import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';

/**
 * RPT — Génération de rapport de campagne (TSD §5.5). Produit un rapport HTML
 * autonome, traçable (auteur, approbateur, WRS, timeline). La génération PDF
 * du TSD peut être ajoutée en aval (impression HTML → PDF).
 */
export function renderCampaignReportHtml(campaign: Campaign, run: CampaignRun): string {
  const g = run.generator;
  const w = run.wrs;
  const esc = (s: string): string =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>Rapport ShieldTest — ${esc(campaign.name)}</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:900px}
 h1{border-bottom:2px solid #333;padding-bottom:.3rem}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
 .score{font-size:2rem;font-weight:700}
 .level{padding:.2rem .6rem;border-radius:4px;background:#eee}
 .muted{color:#666}
</style></head><body>
<h1>Rapport de campagne — WEDOS ShieldTest</h1>
<p class="muted">Généré le ${new Date().toISOString()}</p>
<table>
 <tr><th>Campagne</th><td>${esc(campaign.name)} <span class="muted">(${campaign.id})</span></td></tr>
 <tr><th>Cible</th><td>${esc(campaign.target)}</td></tr>
 <tr><th>Vecteur</th><td>${campaign.vector} (HTTP applicatif borné)</td></tr>
 <tr><th>Auteur</th><td>${esc(campaign.createdBy)}</td></tr>
 <tr><th>Approbateur</th><td>${esc(campaign.approvedBy ?? '—')}</td></tr>
 <tr><th>Statut final</th><td><strong>${run.status}</strong></td></tr>
</table>

<h2>Score de résilience (WRS)</h2>
<p><span class="score">${w.wrs}</span> / 100 &nbsp; <span class="level">Niveau ${w.level}</span></p>
<table>
 <tr><th>Détection (D)</th><td>${w.detection}</td></tr>
 <tr><th>Mitigation (M)</th><td>${w.mitigation}</td></tr>
 <tr><th>Disponibilité (A)</th><td>${w.availability}</td></tr>
 <tr><th>Dommages collatéraux (C)</th><td>${w.collateral}</td></tr>
</table>

<h2>Générateur de charge</h2>
<table>
 <tr><th>Requêtes totales</th><td>${g.totalRequests}</td></tr>
 <tr><th>Succès / échecs</th><td>${g.successful} / ${g.failed}</td></tr>
 <tr><th>RPS effectif</th><td>${g.actualRps}</td></tr>
 <tr><th>Latence p50 / p95 / p99 (ms)</th><td>${g.latencyMs.p50} / ${g.latencyMs.p95} / ${g.latencyMs.p99}</td></tr>
</table>

<h2>Sonde légitime</h2>
<table>
 <tr><th>Échantillons</th><td>${run.probe.samples}</td></tr>
 <tr><th>Disponibilité</th><td>${run.probe.available}/${run.probe.samples}</td></tr>
 <tr><th>Taux d'erreurs 5xx</th><td>${run.probe.errorRate5xx}%</td></tr>
 <tr><th>Latence sonde p50 / p95 / p99 (ms)</th><td>${run.probe.latencyMs.p50} / ${run.probe.latencyMs.p95} / ${run.probe.latencyMs.p99}</td></tr>
</table>

<p class="muted">Rapport traçable — usage interne WEDOS uniquement. Aucun vecteur
volumétrique ou d'épuisement n'est mis en œuvre par ce control plane.</p>
</body></html>`;
}
