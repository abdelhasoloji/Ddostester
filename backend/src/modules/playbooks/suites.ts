import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { wrsLevel } from '../wrs/scoring.js';
import type { WrsLevel } from '../wrs/scoring.js';
import { htmlEscape as esc } from '../../util/text.js';
import { coverBand, docHead, DOC_TAIL, pill, statCard } from '../reports/layout.js';
import { gaugeSvg, scoreColor, REPORT_COLORS, timelineSvg } from '../reports/charts.js';
import { hostOf } from '../../util/net.js';
import {
  assessVector,
  assessSuite,
  type VectorAssessment,
  type VectorVerdict,
} from '../reports/assessment.js';
import { grafanaLink, runWindowMs } from '../reports/grafana.js';

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

/** DRS level parsed from a step name ("… (DRS4)" / "… DRS 4"), or '—'. */
function drsOf(name: string): string {
  const m = /DRS\s*([0-9])/i.exec(name);
  return m ? m[1] : '—';
}

function riskPill(label: string): string {
  return pill(label, label === 'Critical' ? 'crit' : label === 'Medium' ? 'warn' : 'good');
}

/** CSS class + display label per faithful verdict (assessment engine). */
const VERDICT_CLASS: Record<VectorVerdict, string> = {
  held: 'v-held',
  partial: 'v-partial',
  breached: 'r-crit',
  inconclusive: 'v-aborted',
};
const VERDICT_RISK: Record<VectorVerdict, string> = {
  held: 'Low',
  partial: 'Medium',
  inconclusive: 'Medium',
  breached: 'Critical',
};

/**
 * Self-contained per-run "print": inline charts drawn from the run's own timeline
 * (offered load + legitimate availability), so the report carries a pertinent
 * graphic that works offline / in PDF. The Grafana dashboard is loopback-only, so
 * its deep-link is demoted to a small secondary note (it only works with access).
 */
function runChart(
  run: CampaignRun | undefined,
  grafanaUrl: string | undefined,
  targetHost: string,
): string {
  const tl = run?.timeline ?? [];
  const gl = grafanaLink(grafanaUrl, 'run', {
    target: targetHost,
    ...runWindowMs(run?.generator.startedAt, run?.generator.finishedAt),
  });
  const grafanaNote = gl
    ? `<p class="muted" style="font-size:.78rem">📊 Live/historical panels (offered vs origin rps, absorption, availability) in Grafana: <a href="${esc(gl)}" target="_blank" rel="noreferrer">open ↗</a> — requires access to the Grafana instance.</p>`
    : '';
  if (tl.length < 2) return grafanaNote;
  const rpsChart = timelineSvg(
    tl.map((s) => ({ t: s.t, y: s.rps })),
    { yUnit: ' rps', color: REPORT_COLORS.brand, fill: 'rgba(0, 52, 132, 0.10)', height: 120 },
  );
  const availChart = timelineSvg(
    tl.map((s) => ({ t: s.t, y: s.availPct })),
    {
      yMax: 100,
      yUnit: '% avail',
      color: REPORT_COLORS.good,
      fill: REPORT_COLORS.goodFill,
      height: 120,
    },
  );
  return (
    `<div class="figure"><div class="cap">Offered load across the run (req/s).</div>${rpsChart}</div>` +
    `<div class="figure"><div class="cap">Legitimate-probe availability across the run (%).</div>${availChart}</div>` +
    grafanaNote
  );
}

/** Per-attack detail block: faithful verdict, delivered rate, mechanism, caveats + chart. */
function attackDetail(
  nr: number,
  va: VectorAssessment,
  run: CampaignRun | undefined,
  grafanaUrl: string | undefined,
  targetHost: string,
): string {
  const rate = va.configuredRps
    ? `${va.achievedRps}/${va.configuredRps} req/s (${Math.round(va.deliveryRatio * 100)}% of target)`
    : `${va.achievedRps} req/s`;
  const caveats =
    va.caveats.length && va.verdict !== 'breached'
      ? `<tr><th>Caveats</th><td class="v-partial">${va.caveats.map(esc).join(' ')}</td></tr>`
      : '';
  return `<h3>Attack ${nr} / ${esc(va.shape)}</h3>
<table class="kvs">
 <tr><th>DRS level</th><td>${va.drs}</td></tr>
 <tr><th>Delivered rate</th><td>${rate}</td></tr>
 <tr><th>Verdict</th><td class="${VERDICT_CLASS[va.verdict]}">${va.verdict}</td></tr>
 <tr><th>Observation</th><td>${esc(va.observation)}</td></tr>
 ${caveats}
</table>${runChart(run, grafanaUrl, targetHost)}`;
}

/** Glossary — verdict + mechanism definitions used by the assessment engine. */
function glossary(): string {
  return `<h2>Glossary</h2>
<h3>Verdict</h3>
<table class="kvs">
 <tr><th class="v-held">held</th><td>Legitimate availability held (≥99%) at the delivered rate — a valid test the target passed.</td></tr>
 <tr><th class="v-partial">partial</th><td>Some legitimate impact — availability dipped below 99% while the target stayed up.</td></tr>
 <tr><th class="r-crit">breached</th><td>The target went unavailable and the safety kill-switch stopped the run — a real, attributed outage.</td></tr>
 <tr><th class="v-aborted">inconclusive</th><td>The measurement can't prove resilience: the vector under-delivered (achieved ≪ configured rate), the generator was degraded, the probe was contended, or the run was aborted. <b>Not a pass.</b></td></tr>
</table>
<h3>Mechanism</h3>
<table class="kvs">
 <tr><th>served</th><td>The origin served the load directly — the edge absorbed ~nothing. Not necessarily a mitigation: the origin simply coped at this rate.</td></tr>
 <tr><th>rejected / tarpitted</th><td>The edge refused the load with a response (4xx/5xx), or held connections until they timed out.</td></tr>
 <tr><th>shed</th><td>For slow-connection vectors: the target dropped the slow/incomplete connections — the correct defense.</td></tr>
 <tr><th>blocked</th><td>The edge blocked a real fraction but the exact mechanism is unresolved (out-of-process engines report no per-status breakdown).</td></tr>
</table>`;
}

export function renderSuiteReportHtml(
  suite: SuiteSummary,
  runs: CampaignRun[] = [],
  opts: { grafanaUrl?: string } = {},
): string {
  const runById = new Map(runs.map((r) => [r.runId, r] as const));
  const host = hostOf(suite.target);
  const date = esc(suite.createdAt).slice(0, 10);

  // Per-vector assessment from the REAL run — the assessment engine is the single
  // source of truth so the narrative can never drift from what happened.
  const steps = suite.members.map((m) => {
    const run = m.runId ? runById.get(m.runId) : undefined;
    const va = assessVector(run, {
      shape: stepLabel(suite.suiteName, m.name),
      drs: drsOf(m.name),
      status: m.status,
      wrs: m.wrs,
      level: m.level,
    });
    return { m, run, va };
  });
  const scored = steps.filter((s) => s.va.wrs != null);
  const sa = assessSuite(steps.map((s) => s.va));
  const avg = sa.avgWrs ?? 0;
  const worstLevel = sa.worstLevel;

  const narrative = scored.length
    ? `On <b>${date}</b>, WEDOS ShieldTest ran a bounded Layer-7 resilience assessment against <b>${esc(host)}</b> (the live target) — <b>${suite.total}</b> attack vectors, up to <b>DRS ${sa.maxDrs}</b>. ` +
      `<b>${sa.held}/${suite.total}</b> vectors held at their delivered rate` +
      (sa.partial ? `, <b>${sa.partial}</b> caused partial impact` : '') +
      (sa.breached ? `, <b>${sa.breached}</b> breached the target` : '') +
      (sa.inconclusive
        ? `, and <b>${sa.inconclusive}</b> were inconclusive (under-delivered or degraded — not a valid test at the target rate)`
        : '') +
      `. Overall risk is <b>${sa.worstRisk}</b>; worst WRS <b>${sa.worstWrs ?? '—'}</b> (grade ${worstLevel}), average <b>${avg}</b>. ` +
      (sa.breached
        ? `The ${sa.breached} breached shape${sa.breached === 1 ? '' : 's'} took the target unavailable — a business-impacting gap.`
        : sa.inconclusive
          ? `Note: ${sa.inconclusive} vector${sa.inconclusive === 1 ? '' : 's'} never reached the intended intensity, so ${sa.inconclusive === 1 ? 'its' : 'their'} resilience is unproven — re-run on a stronger generator to confirm.`
          : `Legitimate traffic held throughout.`)
    : 'No scored attacks yet.';

  // Per-tier (DRS) worst-case verdict.
  const byDrs = new Map<string, typeof steps>();
  for (const s of steps) {
    const arr = byDrs.get(s.va.drs) ?? [];
    arr.push(s);
    byDrs.set(s.va.drs, arr);
  }
  const tierVerdict = (ss: typeof steps): VectorVerdict =>
    ss.some((s) => s.va.verdict === 'breached')
      ? 'breached'
      : ss.some((s) => s.va.verdict === 'partial')
        ? 'partial'
        : ss.some((s) => s.va.verdict === 'inconclusive')
          ? 'inconclusive'
          : 'held';
  const resultRows = [...byDrs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([drs, ss]) => {
      const maxRps = Math.max(0, ...ss.map((s) => s.va.configuredRps || s.va.achievedRps));
      const tv = tierVerdict(ss);
      const inc = ss.filter((s) => s.va.verdict === 'inconclusive').length;
      const note = inc ? ` (${inc} inconclusive)` : '';
      return `<tr><td>Layer 7 · DRS ${drs}</td><td>${ss.length}</td><td>${maxRps} req/s</td><td>${riskPill(VERDICT_RISK[tv])}</td><td class="${VERDICT_CLASS[tv]}">${tv}${note}</td></tr>`;
    })
    .join('');

  const l7Rows = steps
    .map((s) => {
      const wrsCell =
        s.va.wrs != null ? `<b style="color:${scoreColor(s.va.wrs)}">${s.va.wrs}</b>` : '—';
      const flag =
        !s.va.confident && s.run
          ? ' <span title="not a valid test at the target rate — under-delivered / degraded / contended">⚠</span>'
          : '';
      const rps = s.va.configuredRps
        ? `${s.va.configuredRps}→${s.va.achievedRps}`
        : `${s.va.achievedRps}`;
      return `<tr><td>${s.m.order + 1}</td><td>${esc(s.va.shape)}${flag}</td><td>${rps}</td><td>${s.va.drs}</td><td class="${VERDICT_CLASS[s.va.verdict]}">${s.va.verdict}</td><td>${riskPill(VERDICT_RISK[s.va.verdict])}</td><td>${wrsCell}</td><td>${s.run ? s.va.mechanism : '—'}</td></tr>`;
    })
    .join('');

  const details = steps
    .map((s) => attackDetail(s.m.order + 1, s.va, s.run, opts.grafanaUrl, host))
    .join('');

  const grafanaBanner = opts.grafanaUrl
    ? `<p class="muted" style="font-size:.78rem">📈 Historical resilience trends for ${esc(host)}: <a href="${esc(
        grafanaLink(opts.grafanaUrl, 'resilience', { target: host }) ?? '',
      )}" target="_blank" rel="noreferrer">open in Grafana ↗</a> — requires access to the Grafana instance; the per-attack charts below are self-contained.</p>`
    : '';

  return (
    docHead(`WEDOS ShieldTest — ${esc(host)} L7 resilience`) +
    coverBand(
      `DDoS resilience assessment — Layer 7`,
      `Target ${esc(host)} · ${suite.total} attack vectors · ${date} · WEDOS ShieldTest · confidential`,
    ) +
    `<h2>Management summary</h2><p class="lead">${narrative}</p>${grafanaBanner}
<div class="scorecard">
  <div>${gaugeSvg(avg, { sub: `avg · worst ${worstLevel}`, color: scoreColor(avg) })}
    <div style="text-align:center;font-size:.75rem;color:${REPORT_COLORS.muted}">Assessment resilience (avg WRS)</div></div>
  <div>
    <div class="pills">${riskPill(sa.worstRisk)} ${pill(`${sa.held}/${suite.total} held`, sa.held === suite.total ? 'good' : 'warn')}${sa.breached ? ' ' + pill(`${sa.breached} breached`, 'crit') : ''}${sa.inconclusive ? ' ' + pill(`${sa.inconclusive} inconclusive`, 'warn') : ''}</div>
    <div class="grid cards" style="margin-top:.7rem">
      ${statCard('Vectors', String(suite.total))}
      ${statCard('Worst WRS', sa.worstWrs != null ? String(sa.worstWrs) : '—')}
      ${statCard('Valid at target rate', `${sa.validAtRate}/${suite.total}`, sa.validAtRate === suite.total)}
      ${statCard('Breached', String(sa.breached), false)}
    </div>
  </div>
</div>` +
    `<h2>Results — protection level by DRS</h2>
<table class="kvs"><thead><tr><th>Threat scenario</th><th>Attacks</th><th>Max rate</th><th>RiskLevel</th><th>Verdict</th></tr></thead><tbody>${resultRows}</tbody></table>` +
    `<h2>Layer 7 summary</h2>
<table class="kvs"><thead><tr><th>#</th><th>Attack (shape)</th><th>RPS (cfg→eff)</th><th>DRS</th><th>Verdict</th><th>RiskLevel</th><th>WRS</th><th>Mechanism</th></tr></thead><tbody>${l7Rows}</tbody></table>
<p class="muted" style="font-size:.82rem">Verdict: <b>held</b> = availability held at the delivered rate; <b>partial</b> = some impact; <b>breached</b> = target went unavailable; <b>inconclusive</b> = under-delivered/degraded (not a valid test). ⚠ = not a valid test at the target rate. Mechanism is keyed on the measured absorption/origin traffic — not on status codes, which out-of-process engines don't report.</p>` +
    `<h2>Details — per attack</h2>${details}` +
    glossary() +
    `<p class="muted" style="margin-top:2rem">Consolidated assessment — WEDOS internal use only, must not be disclosed to third parties. Every vector is a bounded, allowlisted HTTP test (GET/POST/slow-header, rate-capped); no volumetric, amplification or spoofing vector is implemented by this control plane.</p>` +
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
