import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';

/**
 * RPT-02 — Aggregated resilience assessment / compliance report.
 * Aggregates runs over a period into a zeroBS-DRS-style assessment (scope,
 * per-scenario results with RiskLevel + mitigation verdict, glossary) plus the
 * DORA / NIS2 / ISO 27001 compliance breakdown. Purely analytical — the report
 * generates no traffic. Methodology: docs/assessment-methodology.md.
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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Probe availability (%) measured during the run; 100 when no probe samples. */
function availabilityPct(run: CampaignRun): number {
  return run.probe.samples ? (run.probe.available / run.probe.samples) * 100 : 100;
}

/**
 * Mitigation / availability verdict (bounded meaning, see methodology §3.2):
 * what happened to legitimate traffic while the bounded load ran.
 */
function mitigationVerdict(run: CampaignRun): { label: string; cls: string } {
  if (run.status === 'KILLED_MANUAL') return { label: 'Aborted', cls: 'v-aborted' };
  if (run.status === 'KILLED_AUTO') return { label: 'Failed (impact)', cls: 'v-fail' };
  return availabilityPct(run) >= 99
    ? { label: 'Held', cls: 'v-held' }
    : { label: 'Partial', cls: 'v-partial' };
}

/** RiskLevel (Low / Medium / Critical), scored on status + availability + WRS. */
function riskLevel(run: CampaignRun): { label: string; cls: string } {
  const avail = availabilityPct(run);
  if (run.status === 'KILLED_AUTO' || run.wrs.wrs < 55 || avail < 90)
    return { label: 'Critical', cls: 'r-crit' };
  if (run.status === 'COMPLETED' && avail >= 99 && run.wrs.wrs >= 80)
    return { label: 'Low', cls: 'r-low' };
  return { label: 'Medium', cls: 'r-med' };
}

export function renderComplianceHtml(
  campaigns: Campaign[],
  runs: CampaignRun[],
  opts: ComplianceOptions = {},
): string {
  const from = opts.from ? Date.parse(opts.from) : -Infinity;
  const to = opts.to ? Date.parse(opts.to) : Infinity;
  const campById = new Map(campaigns.map((c) => [c.id, c]));

  const inPeriod = runs
    .filter((r) => {
      const t = Date.parse(r.generator.finishedAt);
      return t >= from && t <= to;
    })
    .sort((a, b) => Date.parse(a.generator.finishedAt) - Date.parse(b.generator.finishedAt));

  const total = inPeriod.length;
  const byStatus = new Map<string, number>();
  const byLevel = new Map<string, number>();
  let wrsSum = 0;
  let wrsMin = Infinity;
  let anyEstimated = false;
  const perTarget = new Map<string, { n: number; sum: number }>();
  const targets = new Set<string>();
  const engines = new Set<string>();

  for (const r of inPeriod) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    byLevel.set(r.wrs.level, (byLevel.get(r.wrs.level) ?? 0) + 1);
    wrsSum += r.wrs.wrs;
    wrsMin = Math.min(wrsMin, r.wrs.wrs);
    if (r.wrs.estimated) anyEstimated = true;
    const c = campById.get(r.campaignId);
    const host = hostOf(c?.target ?? '—');
    targets.add(host);
    engines.add(c?.agent ?? 'builtin');
    const agg = perTarget.get(host) ?? { n: 0, sum: 0 };
    agg.n += 1;
    agg.sum += r.wrs.wrs;
    perTarget.set(host, agg);
  }

  const wrsAvg = total ? (wrsSum / total).toFixed(1) : '—';
  const wrsMinStr = total ? String(wrsMin) : '—';
  const worst = inPeriod.filter((r) => r.wrs.wrs < 70);
  const row = (k: string, v: string | number) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const period = `${opts.from ? esc(opts.from) : 'origin'} → ${opts.to ? esc(opts.to) : 'now'}`;

  // Per-scenario results table (zeroBS "L7 Summary" shape, bounded).
  const scenarioRows = inPeriod
    .map((r, i) => {
      const c = campById.get(r.campaignId);
      const mit = mitigationVerdict(r);
      const risk = riskLevel(r);
      const rps = Math.round(r.generator.actualRps);
      const note = r.statusDetail
        ? esc(r.statusDetail)
        : `avail ${availabilityPct(r).toFixed(0)}%${
            r.baselineDelta ? ` · Δp95 ${r.baselineDelta.latencyP95DeltaMs} ms` : ''
          }`;
      return `<tr>
 <td>${i + 1}</td>
 <td>${esc(c?.name ?? r.campaignId)}</td>
 <td>${esc(hostOf(c?.target ?? '—'))}</td>
 <td>${rps}</td>
 <td>${r.wrs.wrs} <span class="muted">${r.wrs.level}</span></td>
 <td class="${mit.cls}">${mit.label}</td>
 <td class="${risk.cls}">${risk.label}</td>
 <td class="note">${note}</td>
</tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Resilience assessment — WEDOS ShieldTest</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:960px}
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #003484;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0}.wm{font-weight:800;color:#003484}
 h2{color:#003484;margin-top:1.6rem}
 table{border-collapse:collapse;width:100%;margin:.6rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}
 td.note{color:#444;font-size:.86rem;max-width:280px}
 .muted{color:#666}
 .r-low,.v-held{color:#0f8a5f;font-weight:600}
 .r-med,.v-partial{color:#b8860b;font-weight:600}
 .r-crit,.v-fail{color:#c23b34;font-weight:700}
 .v-aborted{color:#666;font-weight:600}
 .oos{background:#f6f8fa;color:#555;font-size:.86rem;border:1px solid #e1e6ea;border-radius:6px;padding:.6rem .8rem;margin:.6rem 0}
 .print-btn{position:fixed;top:1rem;right:1rem;background:#003484;color:#fff;border:0;border-radius:6px;padding:.5rem .9rem;font:inherit;font-weight:600;cursor:pointer}
 @media print{.print-btn{display:none}body{margin:0}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / PDF</button>
<div class="brand">
 <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4aa0"/><stop offset="1" stop-color="#003484"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
 <h1><span class="wm">WEDOS ShieldTest</span> — Resilience assessment</h1>
</div>
<p class="muted">Period: ${period} · generated on ${new Date().toISOString()} · WEDOS internal use</p>

<h2>Scope</h2>
<table>
 ${row('Runs assessed', total)}
 ${row('Targets', [...targets].map(esc).join(', ') || '—')}
 ${row('Load engines', [...engines].map(esc).join(', ') || '—')}
 ${row('Method', 'Bounded HTTP (GET/POST), allowlisted, capped ≤ 2000 rps / 500 conc / 900 s')}
 ${row('DRS note', 'Customer-defined targets — assessment capped at DRS 4.5 by methodology')}
</table>

<h2>Summary</h2>
<table>
 ${row('Average WRS', wrsAvg)}
 ${row('Minimum WRS', wrsMinStr)}
 ${row('Runs below resilience threshold (WRS &lt; 70)', worst.length)}
</table>
${
  anyEstimated
    ? `<p class="muted">Some runs have <strong>estimated</strong> detection/mitigation
       (no protection integration reported real timings); their outcome reflects
       measured availability. See methodology §3.2.</p>`
    : ''
}

<h2>Per-scenario results (Layer 7, bounded)</h2>
<table>
 <tr><th>#</th><th>Scenario</th><th>Target</th><th>Peak RPS</th><th>WRS</th><th>Mitigation</th><th>RiskLevel</th><th>Notes</th></tr>
 ${scenarioRows || '<tr><td colspan="8" class="muted">No runs in the period.</td></tr>'}
</table>

<div class="oos"><strong>Volumetric / L3-L4 — out of scope.</strong> UDP/TCP/ICMP
floods, amplification, fragmentation and source spoofing are not implemented by
this platform and are not run here. They are validated separately on an isolated
network bench — see <em>drs-validation-policy.md</em> (class C).</div>

<h2>Breakdown by status</h2>
<table>${[...byStatus].map(([k, v]) => row(k, v)).join('') || row('—', 0)}</table>

<h2>Breakdown by WRS level</h2>
<table>${[...byLevel].map(([k, v]) => row(k, v)).join('') || row('—', 0)}</table>

<h2>Coverage by target</h2>
<table><tr><th>Target</th><th>Runs</th><th>Average WRS</th></tr>
${[...perTarget].map(([t, a]) => `<tr><td>${esc(t)}</td><td>${a.n}</td><td>${(a.sum / a.n).toFixed(1)}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
</table>

<h2>Glossary</h2>
<table>
 <tr><th>WRS / DRS</th><td>WEDOS Resiliency Score (0–100). DRS = zeroBS DDoS Resiliency Score; customer-defined targets cap the assessment at DRS 4.5.</td></tr>
 <tr><th>RiskLevel</th><td><span class="r-low">Low</span> availability held & WRS ≥ 80 · <span class="r-med">Medium</span> partial degradation or WRS 55–79 · <span class="r-crit">Critical</span> target unavailable or WRS &lt; 55.</td></tr>
 <tr><th>Mitigation</th><td><span class="v-held">Held</span> ≈100% available · <span class="v-partial">Partial</span> some legitimate traffic lost · <span class="v-fail">Failed</span> auto-killed (target down ≥30 s) · <span class="v-aborted">Aborted</span> manual stop.</td></tr>
 <tr><th>TTD / TTM</th><td>Time-To-Detect / Time-To-Mitigate — populated from the run when a protection source or auto-kill timing is observed.</td></tr>
 <tr><th>RPS</th><td>Requests per second (Layer 7). Volumetric PPS is out of scope.</td></tr>
</table>

<p class="muted">Automatically generated resilience evidence. Bounded HTTP generator —
no volumetric, amplification or spoofing vector. WEDOS internal use.</p>
</body></html>`;
}
