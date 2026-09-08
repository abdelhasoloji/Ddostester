import type { Campaign } from '../campaigns/model.js';
import { wrsLevel } from '../wrs/scoring.js';
import type { WrsLevel } from '../wrs/scoring.js';
import { htmlEscape as esc } from '../../util/text.js';

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

const TERMINAL = ['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL'];

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
export function renderSuiteReportHtml(suite: SuiteSummary): string {
  const rows = suite.members
    .map(
      (m) =>
        `<tr><td>${m.order + 1}</td><td>${esc(m.name)}</td><td>${m.status}</td><td>${
          m.wrs != null ? `${m.wrs} (${m.level})` : '—'
        }</td><td>${m.verdict ?? '—'}</td></tr>`,
    )
    .join('\n');
  const verdictLine = suite.verdict ? `<p><b>SLO verdict: ${suite.verdict}</b></p>` : '';
  const overall = suite.wrs
    ? `<span class="score">${suite.wrs.avg}</span> avg / <span class="score">${suite.wrs.min}</span> min &nbsp; <span class="level">worst level ${suite.wrs.level}</span> &nbsp;(${suite.wrs.scored}/${suite.total} scored)`
    : 'No scored runs yet.';
  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>Assessment report — ${esc(suite.suiteName)}</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.4rem} table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
 .score{font-size:1.2rem;font-weight:700} .level{padding:.1rem .5rem;border:1px solid #999;border-radius:4px}
 .muted{color:#666;font-size:.9rem}
</style></head><body>
<h1>Assessment report — ${esc(suite.suiteName)}</h1>
<p class="muted">Target: <code>${esc(suite.target)}</code> · ${suite.total} campaigns · created ${esc(suite.createdAt)}</p>
<h2>Overall resilience</h2>
<p>${overall}</p>
${verdictLine}
<h2>Steps</h2>
<table><tr><th>#</th><th>Campaign</th><th>Status</th><th>WRS</th><th>SLO</th></tr>
${rows}
</table>
<p class="muted">Consolidated assessment — WEDOS internal use only. Every step is a bounded,
allowlisted HTTP test; no volumetric or exhaustion vector is implemented.</p>
</body></html>`;
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
