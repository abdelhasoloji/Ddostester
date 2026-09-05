import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';

/**
 * RPT-02 — Aggregated compliance report (DORA / NIS2 / ISO 27001).
 * Aggregates runs over a period: volume, statuses, average/min WRS,
 * coverage per target. Purely analytical (no traffic generated).
 */
export interface ComplianceOptions {
  from?: string; // ISO
  to?: string; // ISO
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
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
      /* keep raw */
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
  const period = `${opts.from ? esc(opts.from) : 'origin'} → ${opts.to ? esc(opts.to) : 'now'}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Compliance report — WEDOS ShieldTest</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:900px}
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #003484;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0}.wm{font-weight:800;color:#003484}
 h2{color:#003484}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
 .muted{color:#666}
 .print-btn{position:fixed;top:1rem;right:1rem;background:#003484;color:#fff;border:0;border-radius:6px;padding:.5rem .9rem;font:inherit;font-weight:600;cursor:pointer}
 @media print{.print-btn{display:none}body{margin:0}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / PDF</button>
<div class="brand">
 <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4aa0"/><stop offset="1" stop-color="#003484"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
 <h1><span class="wm">WEDOS ShieldTest</span> — Compliance report (DORA / NIS2 / ISO 27001)</h1>
</div>
<p class="muted">Period: ${period} · generated on ${new Date().toISOString()}</p>

<h2>Summary</h2>
<table>
 ${row('Runs over the period', total)}
 ${row('Average WRS', wrsAvg)}
 ${row('Minimum WRS', wrsMinStr)}
 ${row('Campaigns failing resilience (WRS &lt; 70)', worst.length)}
</table>

<h2>Breakdown by status</h2>
<table>${[...byStatus].map(([k, v]) => row(k, v)).join('') || row('—', 0)}</table>

<h2>Breakdown by WRS level</h2>
<table>${[...byLevel].map(([k, v]) => row(k, v)).join('') || row('—', 0)}</table>

<h2>Coverage by target</h2>
<table><tr><th>Target</th><th>Runs</th><th>Average WRS</th></tr>
${[...perTarget].map(([t, a]) => `<tr><td>${esc(t)}</td><td>${a.n}</td><td>${(a.sum / a.n).toFixed(1)}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
</table>

<p class="muted">Automatically generated resilience evidence. Bounded HTTP generator —
no volumetric vector. WEDOS internal use.</p>
</body></html>`;
}
