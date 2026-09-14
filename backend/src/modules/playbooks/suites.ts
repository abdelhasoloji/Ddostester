import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { wrsLevel } from '../wrs/scoring.js';
import type { WrsLevel } from '../wrs/scoring.js';
import { htmlEscape as esc } from '../../util/text.js';
import { coverBand, docHead, DOC_TAIL, pill, statCard } from '../reports/layout.js';
import { gaugeSvg, scoreColor, REPORT_COLORS, timelineSvg } from '../reports/charts.js';
import { riskLevel } from '../reports/compliance.js';
import { availabilityPct } from '../../util/run-metrics.js';
import { hostOf } from '../../util/net.js';

/**
 * Consolidated view of an assessment suite (campaigns created from one
 * playbook, linked by suiteId). Aggregates status and WRS across the member
 * campaigns so a whole assessment can be read — and reported — as one unit.
 */

export interface SuiteMember {
  id: string;
  name: string;
  order: number;
  status: Campaign['status'];
  wrs?: number;
  level?: WrsLevel;
  verdict?: 'PASS' | 'FAIL';
  runId?: string;
}

export interface SuiteSummary {
  suiteId: string;
  suiteName: string;
  target: string;
  createdAt: string;
  total: number;
  pending: number;
  approved: number;
  running: number;
  completed: number;
  members: SuiteMember[];
  /** Aggregate WRS over scored members, or null if none scored yet. */
  wrs: { avg: number; min: number; level: WrsLevel; scored: number } | null;
  /** Aggregate SLO verdict: FAIL if any member failed, PASS if any judged and none failed, else null. */
  verdict: 'PASS' | 'FAIL' | null;
}

const TERMINAL = ['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL', 'CANCELLED'];

/** Groups campaigns into suites and computes per-suite aggregates. */
export function buildSuites(campaigns: Campaign[]): SuiteSummary[] {
  const bySuite = new Map<string, Campaign[]>();
  for (const c of campaigns) {
    if (!c.suiteId) continue;
    const arr = bySuite.get(c.suiteId) ?? [];
    arr.push(c);
    bySuite.set(c.suiteId, arr);
  }

  const suites: SuiteSummary[] = [];
  for (const [suiteId, members] of bySuite) {
    members.sort((a, b) => (a.suiteOrder ?? 0) - (b.suiteOrder ?? 0));
    const scored = members.filter((m) => m.wrs);
    let wrs: SuiteSummary['wrs'] = null;
    if (scored.length) {
      const values = scored.map((m) => m.wrs!.wrs);
      const avg = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
      const min = Math.min(...values);
      wrs = { avg, min, level: wrsLevel(min), scored: scored.length };
    }
    suites.push({
      suiteId,
      suiteName: members[0].suiteName ?? 'Assessment',
      target: members[0].target,
      createdAt: members.reduce(
        (min, c) => (c.createdAt < min ? c.createdAt : min),
        members[0].createdAt,
      ),
      total: members.length,
      pending: members.filter((c) => c.status === 'PENDING_APPROVAL').length,
      approved: members.filter((c) => c.status === 'APPROVED').length,
      running: members.filter((c) => c.status === 'RUNNING').length,
      completed: members.filter((c) => TERMINAL.includes(c.status)).length,
      members: members.map((c) => ({
        id: c.id,
        name: c.name,
        order: c.suiteOrder ?? 0,
        status: c.status,
        wrs: c.wrs?.wrs,
        level: c.wrs?.level,
        verdict: c.acceptanceResult?.verdict,
        runId: c.runId,
      })),
      wrs,
      verdict: (() => {
        const judged = members.filter((c) => c.acceptanceResult);
        if (judged.length === 0) return null;
        return judged.some((c) => c.acceptanceResult!.verdict === 'FAIL') ? 'FAIL' : 'PASS';
      })(),
    });
  }
  suites.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return suites;
}

/** Renders an aggregated HTML report for one assessment suite. */
const round1 = (v: number): number => Math.round(v * 10) / 10;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Mitigation outcome (zeroBS style: fully / partially / none), from status + availability. */
function mitigationOutcome(
  run: CampaignRun | undefined,
  status: SuiteMember['status'],
): { label: string; cls: string } {
  if (status === 'KILLED_AUTO') return { label: 'none', cls: 'r-crit' };
  if (status === 'KILLED_MANUAL') return { label: 'aborted', cls: 'v-aborted' };
  if (!run) return { label: '—', cls: 'muted' };
  return availabilityPct(run) >= 99
    ? { label: 'fully', cls: 'v-held' }
    : { label: 'partially', cls: 'v-partial' };
}

/** DRS level parsed from a step name ("… (DRS4)" / "… DRS 4"), or '—'. */
function drsOf(name: string): string {
  const m = /DRS\s*([0-9])/i.exec(name);
  return m ? m[1] : '—';
}

function riskPill(label: string): string {
  return pill(label, label === 'Critical' ? 'crit' : label === 'Medium' ? 'warn' : 'good');
}

/** One plain-language observation line for a step, from its run. */
function observationOf(run: CampaignRun | undefined, mit: { label: string }): string {
  if (!run) return 'not run.';
  const a = run.absorption;
  const avail = availabilityPct(run).toFixed(0);
  if (mit.label === 'none')
    return `<b>Not mitigated</b> — the target went unavailable (${avail}% legitimate availability). ${esc(run.statusDetail ?? 'auto-killed to protect the target')}.`;
  const mech = a
    ? a.tarpitRatio && a.tarpitRatio >= (a.rejectedRatio ?? 0)
      ? `mainly by tarpitting (holding connections)`
      : `mainly by rejecting (4xx/5xx)`
    : '';
  return `The edge absorbed <b>${a ? a.absorbedPct : 0}%</b> of the offered load ${mech}; legitimate availability held at <b>${avail}%</b>. WRS ${run.wrs.wrs} (${run.wrs.level}).`;
}

/** Per-attack detail block (zeroBS "Attack N / name" + timeline + observation). */
function attackDetail(
  nr: number,
  shape: string,
  run: CampaignRun | undefined,
  mit: { label: string; cls: string },
  drs: string,
): string {
  const avgRps = run ? Math.round(run.generator.actualRps) : 0;
  const chart =
    run?.timeline && run.timeline.length >= 2
      ? `<div class="figure"><div class="cap">Legitimate-probe availability across the attack (%).</div>${timelineSvg(
          run.timeline.map((s) => ({ t: s.t, y: s.availPct })),
          {
            yMax: 100,
            yUnit: '% avail',
            color: REPORT_COLORS.good,
            fill: REPORT_COLORS.goodFill,
            height: 130,
          },
        )}</div>`
      : '';
  return `<h3>Attack ${nr} / ${esc(shape)}</h3>
<table class="kvs">
 <tr><th>DRS level</th><td>${drs}</td></tr>
 <tr><th>Effective rate</th><td>${avgRps} req/s</td></tr>
 <tr><th>Mitigation</th><td class="${mit.cls}">${mit.label}</td></tr>
 <tr><th>Observation</th><td>${observationOf(run, mit)}</td></tr>
</table>${chart}`;
}

/** Glossary — RiskLevel + Mitigation definitions (zeroBS convention). */
function glossary(): string {
  return `<h2>Glossary</h2>
<h3>RiskLevel</h3>
<table class="kvs">
 <tr><th class="v-held">Low</th><td>Low risk — mitigation instant or within the agreed SLAs, no impact on the infrastructure behind.</td></tr>
 <tr><th class="v-partial">Medium</th><td>Moderate risk — mitigation difficult, partial or by manual intervention; attack traffic passes for &gt;60 s.</td></tr>
 <tr><th class="r-crit">Critical</th><td>No or inadequate mitigation — traffic passes and the target is impacted (here: legitimate availability breached, auto-kill).</td></tr>
</table>
<h3>Mitigation</h3>
<table class="kvs">
 <tr><th class="v-held">fully</th><td>The edge blocked/absorbed the attack and legitimate traffic held (≥99% availability).</td></tr>
 <tr><th class="v-partial">partially</th><td>Some legitimate impact — availability dipped below 99% or the measurement was degraded.</td></tr>
 <tr><th class="r-crit">none</th><td>The attack was not mitigated — the target went unavailable and the safety kill-switch stopped the run.</td></tr>
</table>`;
}

export function renderSuiteReportHtml(suite: SuiteSummary, runs: CampaignRun[] = []): string {
  const runById = new Map(runs.map((r) => [r.runId, r] as const));

  // The report is PER CAMPAIGN (assessment): each member step is one "attack".
  const steps = suite.members.map((m) => {
    const run = m.runId ? runById.get(m.runId) : undefined;
    return {
      m,
      run,
      shape: stepLabel(suite.suiteName, m.name),
      drs: drsOf(m.name),
      rpsEff: run ? Math.round(run.generator.actualRps) : 0,
      rpsCfg: run?.absorption?.configuredRps ?? 0,
      mit: mitigationOutcome(run, m.status),
      risk: run ? riskLevel(run) : { label: '—', cls: 'muted' },
    };
  });

  const scoredRuns = steps.map((s) => s.run).filter((r): r is CampaignRun => !!r);
  const meanAbsorbed = round1(mean(scoredRuns.map((r) => r.absorption?.absorbedPct ?? 0)));
  const degraded = scoredRuns.filter((r) => r.confidence?.degraded).length;
  const fully = steps.filter((s) => s.mit.label === 'fully').length;
  const notMitigated = steps.filter((s) => s.mit.label === 'none').length;
  const worstRisk = steps.some((s) => s.risk.label === 'Critical')
    ? 'Critical'
    : steps.some((s) => s.risk.label === 'Medium')
      ? 'Medium'
      : 'Low';
  const maxDrs = steps.reduce((mx, s) => (s.drs !== '—' && s.drs > mx ? s.drs : mx), '0');

  const avg = suite.wrs?.avg ?? 0;
  const worstLevel = suite.wrs?.level ?? '—';
  const host = hostOf(suite.target);
  const date = esc(suite.createdAt).slice(0, 10);

  const narrative = scoredRuns.length
    ? `On <b>${date}</b>, WEDOS ShieldTest ran a bounded Layer-7 resilience assessment against <b>${esc(host)}</b> — <b>${suite.total}</b> attack vectors, up to <b>DRS ${maxDrs}</b>. ` +
      `The edge <b>fully mitigated ${fully}</b> and <b>failed to mitigate ${notMitigated}</b> vector${notMitigated === 1 ? '' : 's'}; overall risk is <b>${worstRisk}</b>, average WRS <b>${avg}</b> (worst <b>${suite.wrs?.min}</b>, grade ${worstLevel}). ` +
      (notMitigated
        ? `Under the ${notMitigated} unmitigated shape${notMitigated === 1 ? '' : 's'} the target went unavailable (auto-kill) — a business-impacting gap.`
        : `Legitimate traffic held throughout.`) +
      (degraded
        ? ` (${degraded} measurement${degraded === 1 ? '' : 's'} flagged generator-degraded.)`
        : '')
    : 'No scored attacks yet.';

  const byDrs = new Map<string, typeof steps>();
  for (const s of steps) {
    const arr = byDrs.get(s.drs) ?? [];
    arr.push(s);
    byDrs.set(s.drs, arr);
  }
  const resultRows = [...byDrs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([drs, ss]) => {
      const maxRps = Math.max(0, ...ss.map((s) => s.rpsCfg || s.rpsEff));
      const worst = ss.some((s) => s.risk.label === 'Critical')
        ? riskPill('Critical')
        : ss.some((s) => s.risk.label === 'Medium')
          ? riskPill('Medium')
          : riskPill('Low');
      const none = ss.filter((s) => s.mit.label === 'none').length;
      return `<tr><td>Layer 7 · DRS ${drs}</td><td>${ss.length}</td><td>${maxRps} req/s</td><td>${worst}</td><td class="${none ? 'r-crit' : 'v-held'}">${none ? `${none}/${ss.length} not mitigated` : 'fully mitigated'}</td></tr>`;
    })
    .join('');

  const l7Rows = steps
    .map((s) => {
      const wrsCell =
        s.m.wrs != null ? `<b style="color:${scoreColor(s.m.wrs)}">${s.m.wrs}</b>` : '—';
      const abs = s.run?.absorption ? `${s.run.absorption.absorbedPct}%` : '—';
      const conf = s.run?.confidence?.degraded
        ? ' <span title="measurement degraded">⚠</span>'
        : '';
      const rps = s.rpsCfg ? `${s.rpsCfg}→${s.rpsEff}` : `${s.rpsEff}`;
      return `<tr><td>${s.m.order + 1}</td><td>${esc(s.shape)}${conf}</td><td>${rps}</td><td>${s.drs}</td><td class="${s.mit.cls}">${s.mit.label}</td><td class="${s.risk.cls}">${s.risk.label}</td><td>${wrsCell}</td><td>${abs}</td></tr>`;
    })
    .join('');

  const details = steps
    .map((s) => attackDetail(s.m.order + 1, s.shape, s.run, s.mit, s.drs))
    .join('');

  return (
    docHead(`WEDOS ShieldTest — assessment ${suite.suiteName}`) +
    coverBand(
      `DDoS resilience assessment — Layer 7`,
      `Target ${esc(host)} · ${suite.total} attack vectors · ${date} · WEDOS ShieldTest · confidential`,
    ) +
    `<h2>Management summary</h2><p class="lead">${narrative}</p>
<div class="scorecard">
  <div>${gaugeSvg(avg, { sub: `avg · worst ${worstLevel}`, color: scoreColor(avg) })}
    <div style="text-align:center;font-size:.75rem;color:${REPORT_COLORS.muted}">Assessment resilience (avg WRS)</div></div>
  <div>
    <div class="pills">${riskPill(worstRisk)} ${pill(`${fully}/${suite.total} mitigated`, fully === suite.total ? 'good' : 'warn')}${notMitigated ? ' ' + pill(`${notMitigated} not mitigated`, 'crit') : ''}${degraded ? ' ' + pill(`${degraded} degraded`, 'warn') : ''}</div>
    <div class="grid cards" style="margin-top:.7rem">
      ${statCard('Vectors', String(suite.total))}
      ${statCard('Min WRS', suite.wrs ? String(suite.wrs.min) : '—')}
      ${statCard('Mean absorbed', `${meanAbsorbed}%`, meanAbsorbed >= 20)}
      ${statCard('Not mitigated', String(notMitigated), false)}
    </div>
  </div>
</div>` +
    `<h2>Results — protection level by DRS</h2>
<table class="kvs"><thead><tr><th>Threat scenario</th><th>Attacks</th><th>Max rate</th><th>RiskLevel</th><th>Mitigation</th></tr></thead><tbody>${resultRows}</tbody></table>` +
    `<h2>Layer 7 summary</h2>
<table class="kvs"><thead><tr><th>#</th><th>Attack (shape)</th><th>RPS (cfg→eff)</th><th>DRS</th><th>Mitigation</th><th>RiskLevel</th><th>WRS</th><th>Absorbed</th></tr></thead><tbody>${l7Rows}</tbody></table>
<p class="muted" style="font-size:.82rem">Mitigation: <b>fully</b> = blocked/absorbed, legitimate traffic held (≥99% avail); <b>partially</b> = some impact; <b>none</b> = target went unavailable (auto-kill). ⚠ = measurement generator-degraded.</p>` +
    `<h2>Details — per attack</h2>${details}` +
    glossary() +
    `<p class="muted" style="margin-top:2rem">Consolidated assessment — WEDOS internal use only, must not be disclosed to third parties. Every vector is a bounded, allowlisted HTTP test (GET/POST, rate-capped); no volumetric, amplification or spoofing vector is implemented by this control plane.</p>` +
    DOC_TAIL
  );
}

/** Strips the "<suiteName> — " prefix so a step reads as its own line label. */
function stepLabel(suiteName: string, name: string): string {
  const prefix = `${suiteName} — `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Signed WRS delta with an arrow (higher is better); '' when either side is unscored. */
function wrsDelta(a?: number, b?: number): string {
  if (a == null || b == null) return '<span class="muted">—</span>';
  const d = b - a;
  if (d === 0) return '<span class="muted">±0</span>';
  const up = d > 0;
  return `<span class="${up ? 'good' : 'bad'}">${up ? '▲ +' : '▼ '}${d}</span>`;
}

/** How a per-step verdict moved between the two runs (FAIL→PASS is a fix). */
function verdictDelta(a?: 'PASS' | 'FAIL', b?: 'PASS' | 'FAIL'): string {
  if (!a || !b || a === b) return '';
  if (a === 'FAIL' && b === 'PASS') return '<span class="good">fixed</span>';
  return '<span class="bad">regressed</span>';
}

/**
 * RPT-04 — Before / after comparison of two assessment suites instantiated from
 * the same playbook (typically the same target before and after a WEDOS rule
 * change: the "tune-and-replay" loop). Members are paired by step order so each
 * playbook line is shown with its WRS/verdict before (A) → after (B) and the
 * delta. Purely analytical — generates no traffic.
 */
export function renderSuiteCompareHtml(a: SuiteSummary, b: SuiteSummary): string {
  const byOrder = (s: SuiteSummary) => new Map(s.members.map((m) => [m.order, m]));
  const ma = byOrder(a);
  const mb = byOrder(b);
  const orders = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y);

  let improved = 0;
  let regressed = 0;
  const rows = orders
    .map((o) => {
      const x = ma.get(o);
      const y = mb.get(o);
      if (x?.wrs != null && y?.wrs != null) {
        if (y.wrs > x.wrs) improved++;
        else if (y.wrs < x.wrs) regressed++;
      }
      const label = stepLabel(a.suiteName, x?.name ?? y?.name ?? `Step ${o + 1}`);
      const cell = (m?: SuiteMember) =>
        m?.wrs != null
          ? `${m.wrs} <span class="muted">${m.level}</span>${m.verdict ? ` · ${m.verdict}` : ''}`
          : '<span class="muted">—</span>';
      return `<tr><td>${o + 1}</td><td>${esc(label)}</td><td>${cell(x)}</td><td>${cell(
        y,
      )}</td><td>${wrsDelta(x?.wrs, y?.wrs)} ${verdictDelta(x?.verdict, y?.verdict)}</td></tr>`;
    })
    .join('\n');

  const aggDelta = a.wrs && b.wrs ? wrsDelta(a.wrs.min, b.wrs.min) : '<span class="muted">—</span>';
  const summary =
    a.wrs && b.wrs
      ? `worst-step WRS <b>${a.wrs.min}</b> → <b>${b.wrs.min}</b> (${aggDelta}) · avg ${a.wrs.avg} → ${b.wrs.avg}`
      : 'Not enough scored steps on both runs to summarise.';
  const verdictLine =
    a.verdict && b.verdict && a.verdict !== b.verdict
      ? `<p class="verdict">SLO verdict <span class="${
          a.verdict === 'FAIL' && b.verdict === 'PASS' ? 'good' : 'bad'
        }">${a.verdict} → ${b.verdict}</span></p>`
      : a.verdict || b.verdict
        ? `<p class="verdict">SLO verdict ${a.verdict ?? '—'} → ${b.verdict ?? '—'}</p>`
        : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Suite comparison — WEDOS ShieldTest</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:900px}
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #003484;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0}.wm{font-weight:800;color:#003484}
 h2{color:#003484;margin-top:1.4rem;font-size:1.1rem}
 table{border-collapse:collapse;width:100%;margin:.6rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
 .muted{color:#666}
 .good{color:#0f8a5f;font-weight:700}
 .bad{color:#c23b34;font-weight:700}
 .verdict{font-size:1.05rem;font-weight:700;margin:.4rem 0 0}
 .print-btn{position:fixed;top:1rem;right:1rem;background:#003484;color:#fff;border:0;border-radius:6px;padding:.5rem .9rem;font:inherit;font-weight:600;cursor:pointer}
 @media print{.print-btn{display:none}body{margin:0}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / PDF</button>
<div class="brand">
 <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4aa0"/><stop offset="1" stop-color="#003484"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
 <h1><span class="wm">WEDOS ShieldTest</span> — Suite comparison (tune &amp; replay)</h1>
</div>
<p class="muted">Generated on ${new Date().toISOString()} · WEDOS internal use</p>
<p class="muted">Playbook <b>${esc(a.suiteName)}</b> · target <code>${esc(a.target)}</code></p>
<p>A (before): <code>${esc(a.createdAt)}</code> &nbsp;→&nbsp; B (after): <code>${esc(b.createdAt)}</code></p>
<h2>Overall</h2>
<p>${summary}</p>
<p><b>${improved}</b> step(s) improved · <b>${regressed}</b> regressed · ${
    orders.length - improved - regressed
  } unchanged/unscored</p>
${verdictLine}
<h2>Per-line WRS &amp; verdict</h2>
<table><tr><th>#</th><th>Step</th><th>A (before)</th><th>B (after)</th><th>Δ WRS</th></tr>
${rows}
</table>
<p class="muted">Steps are paired by playbook order. Bounded HTTP generator only —
no volumetric or exhaustion vector. WRS is driven mainly by the legitimate probe;
a higher WRS after a rule change means better protection with less collateral.</p>
</body></html>`;
}
