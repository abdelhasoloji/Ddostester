import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import type { BenchScenario, BenchCoverage, CoverageMethod } from '../bench/model.js';
import { coverBand, docHead, DOC_TAIL, pill, statCard } from './layout.js';
import { gaugeSvg, hbarsSvg, sparklineSvg, scoreColor, REPORT_COLORS } from './charts.js';
import { aggregateRemediations, SEVERITY_PILL } from './remediations.js';
import { htmlEscape as esc } from '../../util/text.js';
import { hostOf } from '../../util/net.js';
import { availabilityPct } from '../../util/run-metrics.js';

// Re-exported for the compare/report modules that historically imported these
// run helpers from here.
export { availabilityPct };

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
  /** Class-C network-bench coverage (zeroBS Volumetric matrix + evidence). */
  bench?: { scenarios: BenchScenario[]; coverage: BenchCoverage[] };
}

const METHOD_PILL: Record<CoverageMethod, 'good' | 'warn' | 'neutral'> = {
  MEASURED_LAB: 'good',
  INGESTED_EXTERNAL: 'neutral',
  ATTESTED: 'warn',
  MODELLED: 'neutral',
  REPLAY: 'neutral',
};

/**
 * Class-C bench coverage section: the zeroBS Volumetric matrix with, per vector,
 * its DRS level and how it is covered (measured in the lab, ingested from the
 * network team's bench, attested, modelled). Read-only evidence — no emission.
 */
function benchCoverageSection(bench?: ComplianceOptions['bench']): string {
  if (!bench || bench.scenarios.length === 0) return '';
  const latest = new Map<string, BenchCoverage>();
  for (const c of [...bench.coverage].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!latest.has(c.vector)) latest.set(c.vector, c);
  }
  const total = bench.scenarios.length;
  const measured = bench.scenarios.filter(
    (s) => latest.get(s.id)?.method === 'MEASURED_LAB',
  ).length;
  const covered = bench.scenarios.filter((s) => latest.has(s.id)).length;
  const neverEmit = bench.scenarios.filter((s) => !s.reproducible).length;
  const rows = bench.scenarios
    .map((s) => {
      const c = latest.get(s.id);
      const method = c
        ? pill(c.method.replace('_', ' '), METHOD_PILL[c.method])
        : pill('not covered', 'crit');
      const bcell = s.reproducible ? pill('reproducible', 'good') : pill('out of model', 'neutral');
      const ev = c
        ? `${c.outcome ? '<b>' + esc(c.outcome) + '</b> ' : ''}${esc(c.summary)} <span class="muted">· ${esc(c.source)}</span>`
        : esc(s.note);
      return `<tr><td><code>${esc(s.id)}</code></td><td>${esc(s.proto)}</td><td>${s.drs}</td><td>${bcell}</td><td>${method}</td><td>${ev}</td></tr>`;
    })
    .join('');
  return `<h2>Network bench (class C) — zeroBS Volumetric coverage</h2>
<div class="grid cards" style="margin-bottom:.7rem">
  ${statCard('Vectors', String(total))}
  ${statCard('Measured (lab)', String(measured))}
  ${statCard('Covered (any method)', String(covered))}
  ${statCard('Never emitted', String(neverEmit))}
</div>
<table>
 <thead><tr><th>Vector</th><th>Proto</th><th>DRS</th><th>Bench</th><th>Coverage method</th><th>Latest evidence</th></tr></thead>
 <tbody>${rows}</tbody>
</table>
<p class="muted" style="font-size:.8rem">Class C (network bench). Measured vectors are bounded, synthetic, no-spoof lab
runs; the rest are covered by attestation, ingestion from the network team's bench, or modelling. Source-IP spoofing and
raw floods are never emitted by construction.</p>`;
}

/**
 * Mitigation / availability verdict (bounded meaning, see methodology §3.2):
 * what happened to legitimate traffic while the bounded load ran.
 */
export function mitigationVerdict(run: CampaignRun): { label: string; cls: string } {
  if (run.status === 'KILLED_MANUAL') return { label: 'Aborted', cls: 'v-aborted' };
  if (run.status === 'KILLED_AUTO') return { label: 'Failed (impact)', cls: 'v-fail' };
  return availabilityPct(run) >= 99
    ? { label: 'Held', cls: 'v-held' }
    : { label: 'Partial', cls: 'v-partial' };
}

/** RiskLevel (Low / Medium / Critical), scored on status + availability + WRS. */
export function riskLevel(run: CampaignRun): { label: string; cls: string } {
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

  const wrsAvgNum = total ? wrsSum / total : 0;
  const wrsAvg = total ? wrsAvgNum.toFixed(1) : '—';
  const wrsMinStr = total ? String(wrsMin) : '—';
  const worst = inPeriod.filter((r) => r.wrs.wrs < 70);
  const row = (k: string, v: string | number) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const period = `${opts.from ? esc(opts.from) : 'origin'} → ${opts.to ? esc(opts.to) : 'now'}`;

  // Risk distribution across the period.
  const riskCount = { Low: 0, Medium: 0, Critical: 0 };
  for (const r of inPeriod) riskCount[riskLevel(r).label as keyof typeof riskCount]++;
  const meanAbsorbed = inPeriod.length
    ? Math.round(
        (inPeriod.reduce((s, r) => s + (r.absorption?.absorbedPct ?? 0), 0) / inPeriod.length) * 10,
      ) / 10
    : 0;
  const degradedCount = inPeriod.filter((r) => r.confidence?.degraded).length;

  // Management summary — plain-language, generated from the aggregates.
  const summary = total
    ? `Across <b>${period}</b>, <b>${total}</b> bounded assessment${total > 1 ? 's' : ''} ran against ` +
      `<b>${targets.size}</b> target${targets.size > 1 ? 's' : ''} using ${[...engines].map(esc).join(', ')}. ` +
      `The average WEDOS Resiliency Score was <b>${wrsAvg}</b> (lowest ${wrsMinStr}); ` +
      `<b>${worst.length}</b> run${worst.length === 1 ? '' : 's'} fell below the resilience threshold of 70. ` +
      `RiskLevel spread: ${riskCount.Low} Low · ${riskCount.Medium} Medium · <b>${riskCount.Critical} Critical</b>. ` +
      (anyEstimated
        ? `Some runs have estimated detection/mitigation (no protection source), so their score reflects measured availability.`
        : `Detection/mitigation timings were measured for these runs.`)
    : `No bounded assessments were recorded in <b>${period}</b>.`;

  // WRS-by-level distribution (single hue), ordered best→worst.
  const LEVEL_ORDER = ['A+', 'A', 'B', 'C', 'D', 'E', 'F'];
  const levelBars = hbarsSvg(
    LEVEL_ORDER.filter((l) => byLevel.has(l)).map((l) => ({
      label: `Grade ${l}`,
      value: byLevel.get(l) ?? 0,
      display: String(byLevel.get(l) ?? 0),
    })),
    { max: Math.max(1, ...byLevel.values()) },
  );
  // Risk distribution, status-coloured (with labels, never colour alone).
  const riskBars = hbarsSvg(
    [
      { label: 'Low', value: riskCount.Low, display: String(riskCount.Low) },
      { label: 'Medium', value: riskCount.Medium, display: String(riskCount.Medium) },
      { label: 'Critical', value: riskCount.Critical, display: String(riskCount.Critical) },
    ],
    {
      max: Math.max(1, riskCount.Low, riskCount.Medium, riskCount.Critical),
      barColor: (v) =>
        v === riskCount.Critical && v > 0
          ? REPORT_COLORS.crit
          : v === riskCount.Medium
            ? REPORT_COLORS.warn
            : REPORT_COLORS.good,
    },
  );
  // WRS trend across the period (chronological).
  const trend = sparklineSvg(
    inPeriod.map((r) => r.wrs.wrs),
    { yMax: 100, width: 240, height: 44 },
  );

  // Per-scenario results table (zeroBS "L7 Summary" shape, bounded).
  const scenarioRows = inPeriod
    .map((r, i) => {
      const c = campById.get(r.campaignId);
      const mit = mitigationVerdict(r);
      const risk = riskLevel(r);
      const g = r.generator;
      const rps = Math.round(g.actualRps);
      // Show configured intent → effective achieved, so a flood the target
      // throttled isn't misread as a trivial test (achieved rate only).
      const cfgRps = c?.maxRps ?? 0;
      const loadCell = cfgRps ? `${cfgRps}→${rps}` : `${rps}`;
      const succRatio = g.totalRequests ? g.successful / g.totalRequests : 1;
      const absorbed =
        cfgRps > 0 && (rps < cfgRps * 0.6 || (g.totalRequests > 50 && succRatio < 0.5));
      const ttdttm = r.protection
        ? `TTD ${r.protection.detectionTimeSec}s · TTM ${r.protection.mitigationTimeSec}s · `
        : '';
      const degraded = r.confidence?.degraded ?? false;
      const note =
        ttdttm +
        (r.statusDetail
          ? esc(r.statusDetail)
          : `avail ${availabilityPct(r).toFixed(0)}%${
              r.baselineDelta ? ` · Δp95 ${r.baselineDelta.latencyP95DeltaMs} ms` : ''
            }`) +
        (absorbed
          ? ` · protection absorbed the flood (${g.successful.toLocaleString('en-US')}/${g.totalRequests.toLocaleString('en-US')} ok)`
          : '') +
        (degraded
          ? ` · <b>⚠ measurement degraded</b> (${esc(r.confidence?.reasons[0] ?? 'generator-side bottleneck')})`
          : '');
      return `<tr>
 <td>${i + 1}</td>
 <td>${esc(c?.name ?? r.campaignId)}</td>
 <td>${esc(hostOf(c?.target ?? '—'))}</td>
 <td>${loadCell}</td>
 <td><b style="color:${scoreColor(r.wrs.wrs)}">${r.wrs.wrs}</b> <span class="muted">${r.wrs.level}</span>${degraded ? ' <span title="measurement degraded — WRS may be understated">⚠</span>' : ''}</td>
 <td class="${mit.cls}">${mit.label}</td>
 <td class="${risk.cls}">${risk.label}</td>
 <td class="note">${note}</td>
</tr>`;
    })
    .join('');

  const benchSection = benchCoverageSection(opts.bench);

  // Post-test weaknesses + concrete remediations, ranked across the period.
  const remediations = aggregateRemediations(
    inPeriod.map((r) => ({
      campaign: campById.get(r.campaignId) ?? ({ id: r.campaignId } as Campaign),
      run: r,
    })),
  );
  const remediationSection = remediations.length
    ? `<h2>Weaknesses &amp; recommended remediations</h2>
<p class="muted">Ranked across ${total} run${total === 1 ? '' : 's'} — "Affected" is how many runs showed each weakness.</p>
<table class="remediations"><thead><tr><th>Severity</th><th>Weakness (observed)</th><th>Recommended remediation</th><th>Affected</th></tr></thead>
<tbody>${remediations
        .map(
          (r) =>
            `<tr><td>${pill(r.severity, SEVERITY_PILL[r.severity])}</td><td>${esc(r.weakness)}</td><td>${esc(r.remediation)}</td><td>${r.affected}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<h2>Weaknesses &amp; recommended remediations</h2><p class="muted">No weaknesses identified across the assessed runs — targets held cleanly.</p>`;

  return (
    docHead('Resilience assessment — WEDOS ShieldTest') +
    coverBand(
      'Resilience assessment',
      `Period ${period} · generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    ) +
    `<p class="lead">${summary}</p>` +
    `<h2>At a glance</h2>
<div class="scorecard">
  <div>${gaugeSvg(wrsAvgNum, { sub: 'avg WRS', color: scoreColor(wrsAvgNum) })}
    <div style="text-align:center;font-size:.75rem;color:${REPORT_COLORS.muted}">Average across ${total} run${total === 1 ? '' : 's'}</div></div>
  <div>
    <div class="pills">${pill(`${riskCount.Critical} Critical`, riskCount.Critical ? 'crit' : 'neutral')} ${pill(`${riskCount.Medium} Medium`, riskCount.Medium ? 'warn' : 'neutral')} ${pill(`${riskCount.Low} Low`, 'good')}</div>
    <div class="grid cards" style="margin-top:.7rem">
      ${statCard('Runs assessed', String(total))}
      ${statCard('Minimum WRS', wrsMinStr)}
      ${statCard('Below WRS 70', String(worst.length))}
      ${statCard('Mean absorbed', `${meanAbsorbed}%`, meanAbsorbed >= 20)}
      ${statCard('Degraded measurements', String(degradedCount), false)}
      ${statCard('Targets', String(targets.size))}
    </div>
    <div style="margin-top:.5rem"><span class="muted" style="font-size:.8rem">WRS trend </span>${trend}</div>
  </div>
</div>` +
    `<h2>Scope</h2>
<table class="kvs">
 ${row('Runs assessed', total)}
 ${row('Targets', [...targets].map(esc).join(', ') || '—')}
 ${row('Load engines', [...engines].map(esc).join(', ') || '—')}
 ${row('Method', 'Bounded HTTP (GET/POST), allowlisted, capped ≤ 2000 rps / 500 conc / 900 s')}
 ${row('DRS note', 'Customer-defined targets — assessment capped at DRS 4.5 by methodology')}
</table>` +
    `<h2>Score &amp; risk distribution</h2>
<div class="two-col">
  <div class="figure"><div class="cap">Runs by WRS grade</div>${byLevel.size ? levelBars : '<div class="chart-empty">No runs in the period.</div>'}</div>
  <div class="figure"><div class="cap">Runs by RiskLevel</div>${total ? riskBars : '<div class="chart-empty">No runs in the period.</div>'}</div>
</div>` +
    `<h2>Per-scenario results (Layer 7, bounded)</h2>
<table>
 <thead><tr><th>#</th><th>Scenario</th><th>Target</th><th>Load rps (cfg&rarr;eff)</th><th>WRS</th><th>Mitigation</th><th>RiskLevel</th><th>Notes</th></tr></thead>
 <tbody>${scenarioRows || '<tr><td colspan="8" class="muted">No runs in the period.</td></tr>'}</tbody>
</table>

<div class="callout info"><strong>Volumetric / L3-L4 — class C, network bench.</strong> UDP/TCP/ICMP
floods, amplification, fragmentation and source spoofing are never run by this
control plane. The UDP amplification and no-spoof TCP state-table shapes are
measured on the isolated network bench; spoofing/GRE/fragmentation are covered by
attestation or ingestion — see <em>drs-validation-policy.md</em> and the coverage
matrix below.</div>

${remediationSection}

${benchSection}

<h2>Coverage by target</h2>
<table>
 <thead><tr><th>Target</th><th>Runs</th><th>Average WRS</th></tr></thead>
 <tbody>${[...perTarget].map(([t, a]) => `<tr><td>${esc(t)}</td><td>${a.n}</td><td><b style="color:${scoreColor(a.sum / a.n)}">${(a.sum / a.n).toFixed(1)}</b></td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</tbody>
</table>

<h2>Breakdown by status</h2>
<table class="kvs">${[...byStatus].map(([k, v]) => row(k, v)).join('') || row('—', 0)}</table>

<h2>Glossary</h2>
<table class="kvs">
 <tr><th>WRS / DRS</th><td>WEDOS Resiliency Score (0–100). DRS = zeroBS DDoS Resiliency Score; customer-defined targets cap the assessment at DRS 4.5.</td></tr>
 <tr><th>RiskLevel</th><td><span class="r-low">Low</span> availability held &amp; WRS ≥ 80 · <span class="r-med">Medium</span> partial degradation or WRS 55–79 · <span class="r-crit">Critical</span> target unavailable or WRS &lt; 55.</td></tr>
 <tr><th>Mitigation</th><td><span class="v-held">Held</span> ≈100% available · <span class="v-partial">Partial</span> some legitimate traffic lost · <span class="v-fail">Failed</span> auto-killed (target down ≥30 s) · <span class="v-aborted">Aborted</span> manual stop.</td></tr>
 <tr><th>TTD / TTM</th><td>Time-To-Detect / Time-To-Mitigate — populated from the run when a protection source or auto-kill timing is observed.</td></tr>
 <tr><th>RPS</th><td>Requests per second (Layer 7). <b>cfg&rarr;eff</b> = configured cap &rarr; effective rate the target sustained; a large gap means the protection rate-limited or tarpitted the flood. Volumetric PPS is out of scope.</td></tr>
</table>

<p class="muted" style="margin-top:2rem">Automatically generated resilience evidence. Bounded HTTP generator —
no volumetric, amplification or spoofing vector. WEDOS internal use.</p>` +
    DOC_TAIL
  );
}
