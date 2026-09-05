import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { htmlEscape as esc } from '../../util/text.js';

/**
 * RPT — Campaign report generation (TSD §5.5). Produces a self-contained,
 * traceable HTML report (author, approver, WRS, timeline). PDF generation from
 * the TSD can be layered on top (print HTML → PDF).
 */
export function renderCampaignReportHtml(campaign: Campaign, run: CampaignRun): string {
  const g = run.generator;
  const w = run.wrs;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>ShieldTest report — ${esc(campaign.name)}</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:900px}
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #003484;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0;border:0}
 .brand .wm{font-weight:800;color:#003484}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
 h2{color:#003484}
 .score{font-size:2rem;font-weight:700;color:#003484}
 .level{padding:.2rem .6rem;border-radius:4px;background:#e3f0fc;color:#003484;font-weight:700}
 .muted{color:#666}
 .print-btn{position:fixed;top:1rem;right:1rem;background:#003484;color:#fff;border:0;border-radius:6px;padding:.5rem .9rem;font:inherit;font-weight:600;cursor:pointer}
 @media print{.print-btn{display:none}body{margin:0}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / PDF</button>
<div class="brand">
  <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4aa0"/><stop offset="1" stop-color="#003484"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <h1><span class="wm">WEDOS ShieldTest</span> — Campaign report</h1>
</div>
<p class="muted">Generated on ${new Date().toISOString()}</p>
<table>
 <tr><th>Campaign</th><td>${esc(campaign.name)} <span class="muted">(${campaign.id})</span></td></tr>
 <tr><th>Target</th><td>${esc(campaign.target)}</td></tr>
 <tr><th>Vector</th><td>${campaign.vector} (bounded application HTTP)</td></tr>
 <tr><th>Author</th><td>${esc(campaign.createdBy)}</td></tr>
 <tr><th>Approver</th><td>${esc(campaign.approvedBy ?? '—')}</td></tr>
 <tr><th>Final status</th><td><strong>${run.status}</strong></td></tr>
</table>

<h2>Resiliency score (WRS)</h2>
<p><span class="score">${w.wrs}</span> / 100 &nbsp; <span class="level">Level ${w.level}</span></p>
<table>
 <tr><th>Detection (D)${w.estimated ? ' *' : ''}</th><td>${w.detection}</td></tr>
 <tr><th>Mitigation (M)${w.estimated ? ' *' : ''}</th><td>${w.mitigation}</td></tr>
 <tr><th>Availability (A)</th><td>${w.availability}</td></tr>
 <tr><th>Collateral damage (C)</th><td>${w.collateral}</td></tr>
</table>
${
  w.estimated
    ? `<p class="muted">* Detection and Mitigation are <strong>estimated</strong> (no protection
       integration reports the real timings): they are constant, so the WRS mostly reflects the
       measured Availability and Collateral damage.</p>`
    : ''
}

<h2>Load generator</h2>
<table>
 <tr><th>Total requests</th><td>${g.totalRequests}</td></tr>
 <tr><th>Success / failures</th><td>${g.successful} / ${g.failed}</td></tr>
 <tr><th>Effective RPS</th><td>${g.actualRps}</td></tr>
 <tr><th>Latency p50 / p95 / p99 (ms)</th><td>${g.latencyMs.p50} / ${g.latencyMs.p95} / ${g.latencyMs.p99}</td></tr>
</table>

<h2>Legitimate probe</h2>
<table>
 <tr><th>Samples</th><td>${run.probe.samples}</td></tr>
 <tr><th>Availability</th><td>${run.probe.available}/${run.probe.samples}</td></tr>
 <tr><th>5xx error rate</th><td>${run.probe.errorRate5xx}%</td></tr>
 <tr><th>Probe latency p50 / p95 / p99 (ms)</th><td>${run.probe.latencyMs.p50} / ${run.probe.latencyMs.p95} / ${run.probe.latencyMs.p99}</td></tr>
</table>
${
  run.posture
    ? `<h2>Protection posture (inferred)</h2>
<table>
 <tr><th>WAF</th><td>${run.posture.waf ? 'detected' : 'not detected'}</td></tr>
 <tr><th>CDN</th><td>${run.posture.cdn ? 'detected' : 'not detected'}</td></tr>
 <tr><th>Rate limiting</th><td>${run.posture.rateLimiting ? 'detected' : 'not detected'}</td></tr>
 <tr><th>Load balancer</th><td>${run.posture.loadBalancer ? 'detected' : 'not detected'}</td></tr>
 <tr><th>HSTS</th><td>${run.posture.hsts ? 'enabled' : 'not set'}</td></tr>
 <tr><th>Hardening headers</th><td>${run.posture.securityHeaders.join(', ') || '—'}</td></tr>
</table>
<p class="muted">Inferred passively from the legitimate probe's own responses (no scanning).</p>`
    : ''
}
<p class="muted">Traceable report — WEDOS internal use only. No volumetric or
exhaustion vector is implemented by this control plane.</p>
</body></html>`;
}
