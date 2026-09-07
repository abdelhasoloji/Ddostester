import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { availabilityPct, mitigationVerdict, riskLevel } from './compliance.js';

/**
 * RPT-03 — Before / after comparison of two runs (typically the same target
 * before and after a protection change: "did the DRS improve?"). Purely
 * analytical — generates no traffic. See docs/assessment-methodology.md.
 */

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface CompareSide {
  campaign: Campaign;
  run: CampaignRun;
}

/** Signed delta with an arrow; `betterWhenUp` decides the good direction. */
function delta(a: number, b: number, betterWhenUp: boolean, unit = ''): string {
  const d = Math.round((b - a) * 10) / 10;
  if (d === 0) return `±0${unit}`;
  const up = d > 0;
  const good = up === betterWhenUp;
  const arrow = up ? '▲' : '▼';
  const cls = good ? 'good' : 'bad';
  return `<span class="${cls}">${arrow} ${up ? '+' : ''}${d}${unit}</span>`;
}

export function renderCompareHtml(a: CompareSide, b: CompareSide): string {
  const aAvail = availabilityPct(a.run);
  const bAvail = availabilityPct(b.run);
  const aP95 = a.run.probe.latencyMs.p95;
  const bP95 = b.run.probe.latencyMs.p95;
  const wrsDelta = b.run.wrs.wrs - a.run.wrs.wrs;
  const verdict =
    wrsDelta > 0
      ? { label: `Improved (+${wrsDelta} WRS)`, cls: 'good' }
      : wrsDelta < 0
        ? { label: `Regressed (${wrsDelta} WRS)`, cls: 'bad' }
        : { label: 'No change', cls: 'muted' };

  const aRisk = riskLevel(a.run);
  const bRisk = riskLevel(b.run);
  const aMit = mitigationVerdict(a.run);
  const bMit = mitigationVerdict(b.run);

  const row = (label: string, av: string, bv: string, d = ''): string =>
    `<tr><th>${label}</th><td>${av}</td><td>${bv}</td><td>${d}</td></tr>`;

  const ttd = (r: CampaignRun): string =>
    r.protection ? `${r.protection.detectionTimeSec}s` : '—';
  const ttm = (r: CampaignRun): string =>
    r.protection ? `${r.protection.mitigationTimeSec}s` : '—';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Resilience comparison — WEDOS ShieldTest</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:900px}
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #003484;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0}.wm{font-weight:800;color:#003484}
 h2{color:#003484;margin-top:1.4rem}
 table{border-collapse:collapse;width:100%;margin:.6rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
 .muted{color:#666}
 .good,.r-low,.v-held{color:#0f8a5f;font-weight:700}
 .bad,.r-crit,.v-fail{color:#c23b34;font-weight:700}
 .r-med,.v-partial{color:#b8860b;font-weight:700}
 .v-aborted{color:#666;font-weight:600}
 .verdict{font-size:1.1rem;font-weight:700;margin:.4rem 0 0}
 .print-btn{position:fixed;top:1rem;right:1rem;background:#003484;color:#fff;border:0;border-radius:6px;padding:.5rem .9rem;font:inherit;font-weight:600;cursor:pointer}
 @media print{.print-btn{display:none}body{margin:0}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / PDF</button>
<div class="brand">
 <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4aa0"/><stop offset="1" stop-color="#003484"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
 <h1><span class="wm">WEDOS ShieldTest</span> — Resilience comparison (before / after)</h1>
</div>
<p class="muted">Generated on ${new Date().toISOString()} · WEDOS internal use</p>
<p class="verdict"><span class="${verdict.cls}">${verdict.label}</span></p>

<table>
 <tr><th>Metric</th><th>A — ${esc(a.campaign.name)}</th><th>B — ${esc(b.campaign.name)}</th><th>Δ (A→B)</th></tr>
 ${row('Target', esc(hostOf(a.campaign.target)), esc(hostOf(b.campaign.target)))}
 ${row('Run finished', esc(a.run.generator.finishedAt), esc(b.run.generator.finishedAt))}
 ${row('WRS', `${a.run.wrs.wrs} <span class="muted">${a.run.wrs.level}</span>`, `${b.run.wrs.wrs} <span class="muted">${b.run.wrs.level}</span>`, delta(a.run.wrs.wrs, b.run.wrs.wrs, true))}
 ${row('Availability', `${aAvail.toFixed(0)}%`, `${bAvail.toFixed(0)}%`, delta(aAvail, bAvail, true, ' pts'))}
 ${row('Probe latency p95', `${aP95} ms`, `${bP95} ms`, delta(aP95, bP95, false, ' ms'))}
 ${row('Mitigation', `<span class="${aMit.cls}">${aMit.label}</span>`, `<span class="${bMit.cls}">${bMit.label}</span>`)}
 ${row('RiskLevel', `<span class="${aRisk.cls}">${aRisk.label}</span>`, `<span class="${bRisk.cls}">${bRisk.label}</span>`)}
 ${row('Time to detect (TTD)', ttd(a.run), ttd(b.run))}
 ${row('Time to mitigate (TTM)', ttm(a.run), ttm(b.run))}
 ${row('Final status', a.run.status, b.run.status)}
</table>

<p class="muted">Bounded HTTP generator — no volumetric vector. Detection/mitigation
timings are measured only when a protection source reports them (else estimated).</p>
</body></html>`;
}
