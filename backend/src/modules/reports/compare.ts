import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { mitigationVerdict, riskLevel } from './compliance.js';
import { deriveRemediations } from './remediations.js';
import type { Remediation } from './remediations.js';
import { availabilityPct } from '../../util/run-metrics.js';
import { htmlEscape as esc } from '../../util/text.js';
import { hostOf } from '../../util/net.js';
import { runComparability } from './comparability.js';

/**
 * RPT-03 — Before / after comparison of two runs (typically the same target
 * before and after a protection change: "did the DRS improve?"). Purely
 * analytical — generates no traffic. See docs/assessment-methodology.md.
 */

export interface CompareSide {
  campaign: Campaign;
  run: CampaignRun;
}

// --- Structured comparison (Mitigation Proof) --------------------------------
// The verdict/delta logic used to live only inside the HTML template. Promoted
// here as a pure, reusable object so the UI and API can consume it directly.

export type CompareVerdict = 'improved' | 'regressed' | 'unchanged' | 'inconclusive';

export interface MetricDelta {
  key: string;
  label: string;
  unit?: string;
  /** null when the metric is absent on a run (e.g. old runs lack absorption). */
  before: number | null;
  after: number | null;
  /** after − before, or null when either side is missing. */
  delta: number | null;
  /** Whether a higher value is the good direction. */
  betterWhenUp: boolean;
  /** true = moved the good way · false = the bad way · null = no change / n/a. */
  improved: boolean | null;
}

export interface RunComparison {
  comparability: ReturnType<typeof runComparability>;
  target: string;
  before: RunComparisonSide;
  after: RunComparisonSide;
  wrsDelta: number;
  levelBefore: string;
  levelAfter: string;
  verdict: CompareVerdict;
  headline: string;
  metrics: MetricDelta[];
  /** What still needs fixing on the "after" run (empty when it held cleanly). */
  remainingRemediations: Remediation[];
}

export interface RunComparisonSide {
  runId: string;
  campaign: string;
  at: string;
  wrs: number;
  level: string;
  status: string;
}

/** WRS levels, worst → best, for a categorical level-change verdict. */
const LEVELS = ['F', 'D', 'C', 'B', 'A', 'A+'];
/** A WRS move of at least this many points counts as a real change. */
const WRS_CHANGE_THRESHOLD = 3;

const origin5xx = (r: CampaignRun): number | null =>
  r.generator.statusCounts ? (r.generator.statusCounts['5xx'] ?? 0) : null;

function metricDelta(
  key: string,
  label: string,
  before: number | null,
  after: number | null,
  betterWhenUp: boolean,
  unit?: string,
): MetricDelta {
  const d = before != null && after != null ? Math.round((after - before) * 10) / 10 : null;
  const improved = d != null && d !== 0 ? d > 0 === betterWhenUp : null;
  return { key, label, unit, before, after, delta: d, betterWhenUp, improved };
}

const round0 = (n: number): number => Math.round(n);

/**
 * Structured before/after comparison of two runs — the "did the mitigation
 * work?" verdict plus per-metric deltas. Pure; generates no traffic.
 */
export function compareRuns(a: CompareSide, b: CompareSide): RunComparison {
  const comparability = runComparability(a.run, b.run);
  const before: RunComparisonSide = {
    runId: a.run.runId,
    campaign: a.campaign.name,
    at: a.run.generator.finishedAt,
    wrs: a.run.wrs.wrs,
    level: a.run.wrs.level,
    status: a.run.status,
  };
  const after: RunComparisonSide = {
    runId: b.run.runId,
    campaign: b.campaign.name,
    at: b.run.generator.finishedAt,
    wrs: b.run.wrs.wrs,
    level: b.run.wrs.level,
    status: b.run.status,
  };
  const wrsDelta = Math.round((b.run.wrs.wrs - a.run.wrs.wrs) * 10) / 10;
  const levelUp = LEVELS.indexOf(after.level) > LEVELS.indexOf(before.level);
  const levelDown = LEVELS.indexOf(after.level) < LEVELS.indexOf(before.level);

  let verdict: CompareVerdict = 'unchanged';
  if (wrsDelta >= WRS_CHANGE_THRESHOLD || levelUp) verdict = 'improved';
  else if (wrsDelta <= -WRS_CHANGE_THRESHOLD || levelDown) verdict = 'regressed';
  if (!comparability.comparable) verdict = 'inconclusive';

  const verb =
    verdict === 'improved' ? 'improved' : verdict === 'regressed' ? 'regressed' : 'unchanged';
  const sign = wrsDelta > 0 ? '+' : '';
  const headline = !comparability.comparable
    ? `Comparison inconclusive: ${comparability.reasons.join('; ')}`
    : `Resilience ${verb}: ${before.level}→${after.level} · ` +
      `WRS ${before.wrs}→${after.wrs} (${sign}${wrsDelta})`;

  const metrics: MetricDelta[] = [
    metricDelta('wrs', 'WRS', before.wrs, after.wrs, true),
    metricDelta(
      'availability',
      'Probe availability',
      round0(availabilityPct(a.run)),
      round0(availabilityPct(b.run)),
      true,
      '%',
    ),
    metricDelta(
      'latencyP95',
      'Probe latency p95',
      round0(a.run.probe.latencyMs.p95),
      round0(b.run.probe.latencyMs.p95),
      false,
      ' ms',
    ),
    metricDelta('origin5xx', 'Origin 5xx', origin5xx(a.run), origin5xx(b.run), false),
    metricDelta(
      'absorbedPct',
      'Edge absorbed',
      a.run.absorption ? round0(a.run.absorption.absorbedPct) : null,
      b.run.absorption ? round0(b.run.absorption.absorbedPct) : null,
      true,
      '%',
    ),
  ];

  return {
    comparability,
    target: hostOf(b.campaign.target),
    before,
    after,
    wrsDelta,
    levelBefore: before.level,
    levelAfter: after.level,
    verdict,
    headline,
    metrics: comparability.comparable
      ? metrics
      : metrics.map((metric) => ({ ...metric, improved: null })),
    remainingRemediations: deriveRemediations(b.campaign, b.run),
  };
}

/** Signed delta with an arrow; `betterWhenUp` decides the good direction. */
function directionalDelta(a: number, b: number, betterWhenUp: boolean, unit = ''): string {
  const d = Math.round((b - a) * 10) / 10;
  if (d === 0) return `±0${unit}`;
  const up = d > 0;
  const good = up === betterWhenUp;
  const arrow = up ? '▲' : '▼';
  const cls = good ? 'good' : 'bad';
  return `<span class="${cls}">${arrow} ${up ? '+' : ''}${d}${unit}</span>`;
}

export function renderCompareHtml(a: CompareSide, b: CompareSide): string {
  const comparison = compareRuns(a, b);
  const delta = (before: number, after: number, betterWhenUp: boolean, unit = '') =>
    comparison.comparability.comparable
      ? directionalDelta(before, after, betterWhenUp, unit)
      : `<span class="muted">${Math.round((after - before) * 10) / 10}${unit} (descriptive)</span>`;
  const aAvail = availabilityPct(a.run);
  const bAvail = availabilityPct(b.run);
  const aP95 = a.run.probe.latencyMs.p95;
  const bP95 = b.run.probe.latencyMs.p95;
  const wrsDelta = b.run.wrs.wrs - a.run.wrs.wrs;
  const verdict = !comparison.comparability.comparable
    ? { label: 'Comparison inconclusive', cls: 'muted' }
    : comparison.verdict === 'improved'
      ? { label: `Improved (+${wrsDelta} WRS)`, cls: 'good' }
      : comparison.verdict === 'regressed'
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
${comparison.comparability.comparable ? '' : `<p class="muted">${esc(comparison.comparability.reasons.join('; '))}. Values are descriptive; no improvement conclusion is supported.</p>`}

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
