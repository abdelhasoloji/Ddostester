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
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #0d47a1;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0;border:0}
 .brand .wm{font-weight:800;color:#0d47a1}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
 h2{color:#0d47a1}
 .score{font-size:2rem;font-weight:700;color:#0d47a1}
 .level{padding:.2rem .6rem;border-radius:4px;background:#e3f0fc;color:#0d47a1;font-weight:700}
 .muted{color:#666}
</style></head><body>
<div class="brand">
  <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e88e5"/><stop offset="1" stop-color="#0d47a1"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <h1><span class="wm">WEDOS ShieldTest</span> — Rapport de campagne</h1>
</div>
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
