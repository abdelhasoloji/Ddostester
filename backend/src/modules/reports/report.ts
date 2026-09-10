import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { summarizeTargetTelemetry } from '../target-telemetry/provider.js';
import { htmlEscape as esc } from '../../util/text.js';
import { hostOf } from '../../util/net.js';
import { mitigationVerdict, riskLevel } from './compliance.js';
import { availabilityPct } from '../../util/run-metrics.js';
import { coverBand, docHead, DOC_TAIL, pill, statCard } from './layout.js';
import { gaugeSvg, hbarsSvg, timelineSvg, scoreColor, REPORT_COLORS } from './charts.js';
import { deriveRemediations, SEVERITY_PILL, type Remediation } from './remediations.js';

/** Renders the "Weaknesses & recommended remediations" block (empty → clean note). */
export function remediationsHtml(items: Remediation[]): string {
  if (items.length === 0) {
    return `<h2>Weaknesses &amp; remediations</h2><p class="muted">No weaknesses identified — the target held cleanly for this scenario.</p>`;
  }
  const rows = items
    .map(
      (r) =>
        `<tr><td>${pill(r.severity, SEVERITY_PILL[r.severity])}</td><td>${esc(r.weakness)}</td><td>${esc(r.remediation)}</td></tr>`,
    )
    .join('');
  return `<h2>Weaknesses &amp; recommended remediations</h2>
<table class="kvs remediations"><thead><tr><th>Severity</th><th>Weakness (observed)</th><th>Recommended remediation</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * RPT — Campaign report (TSD §5.5). A self-contained, designed HTML report:
 * cover, management summary, a scorecard with a WRS gauge, the traffic and
 * availability timelines, the WRS component and latency breakdowns, and the
 * supporting detail tables. Prints cleanly to PDF. Methodology:
 * docs/assessment-methodology.md.
 */

const RISK_PILL = { 'r-low': 'good', 'r-med': 'warn', 'r-crit': 'crit' } as const;
const MIT_PILL = {
  'v-held': 'good',
  'v-partial': 'warn',
  'v-fail': 'crit',
  'v-aborted': 'neutral',
} as const;
export function renderCampaignReportHtml(campaign: Campaign, run: CampaignRun): string {
  const g = run.generator;
  const w = run.wrs;
  const tl = run.timeline ?? [];
  const tt = run.targetTelemetry?.length ? summarizeTargetTelemetry(run.targetTelemetry) : null;
  const avail = availabilityPct(run);
  const risk = riskLevel(run);
  const mit = mitigationVerdict(run);
  const peakRps = tl.length
    ? Math.max(...tl.map((s) => s.rps), Math.round(g.actualRps))
    : Math.round(g.actualRps);
  const durSec = tl.length ? Math.max(...tl.map((s) => s.t)) : campaign.maxDurationSec;
  const grade = w.level;

  // Load INTENT vs. what the target actually sustained. A flood the target
  // rate-limits or tarpits shows a low ACHIEVED rate and a low success ratio —
  // reporting only the achieved rate understates the test, and a high score next
  // to "0 successful" reads as a contradiction unless it's explained. Surface
  // both, and split failures into "rejected by the edge" (a response) vs. "no
  // response" (connection held / timed out).
  const configuredRps = campaign.maxRps;
  const statusCounts = g.statusCounts ?? {};
  const errorsByName = g.errors ?? {};
  const rejectedByEdge = Object.entries(statusCounts)
    .filter(([b]) => b !== '2xx' && b !== '3xx')
    .reduce((s, [, n]) => s + n, 0); // 4xx/5xx — the target answered, refusing the request
  const noResponse = Object.values(errorsByName).reduce((s, n) => s + n, 0); // timeouts / conn errors
  const successRatio = g.totalRequests ? g.successful / g.totalRequests : 1;
  const heavilyThrottled = configuredRps > 0 && peakRps < configuredRps * 0.6;
  const mostlyBlocked = g.totalRequests > 50 && successRatio < 0.5;

  // Management summary — plain-language verdict generated from the run.
  const kill = run.status !== 'COMPLETED';
  const summary =
    `Under a bounded HTTP load configured at up to <b>${configuredRps} req/s</b> ` +
    (heavilyThrottled ? `(the target sustained ~<b>${peakRps} req/s</b> effective) ` : '') +
    `for <b>${durSec}s</b> against ` +
    `<b>${esc(hostOf(campaign.target))}</b>, the target scored <b>WRS ${w.wrs} (${grade})</b> — ` +
    `RiskLevel <b>${risk.label}</b>. Legitimate-traffic availability held at <b>${avail.toFixed(1)}%</b> ` +
    `and mitigation is rated <b>${mit.label}</b>. ` +
    (kill
      ? `The run ended early: ${esc(run.statusDetail ?? run.status)}.`
      : `The run completed cleanly with no auto-kill.`) +
    (run.baselineDelta
      ? ` Under load, p95 latency shifted by ${run.baselineDelta.latencyP95DeltaMs} ms vs the pre-load baseline.`
      : '');

  // When the target rejected or throttled most of the flood while legitimate
  // traffic stayed up, say so plainly — otherwise a high score beside a low
  // success count looks contradictory. This is the protection working, not a
  // test failure.
  const absorbedCallout =
    (mostlyBlocked || heavilyThrottled) && !kill
      ? `<div class="callout info"><b>The target's protection absorbed the load.</b> ` +
        `Of ${g.totalRequests.toLocaleString('en-US')} bounded requests, ` +
        `<b>${g.successful.toLocaleString('en-US')}</b> succeeded — ` +
        `${rejectedByEdge.toLocaleString('en-US')} were rejected by the edge (4xx/5xx) and ` +
        `${noResponse.toLocaleString('en-US')} got no response (rate-limited / connection held). ` +
        (heavilyThrottled
          ? `The configured ${configuredRps} req/s was throttled to ~${peakRps} req/s effective. `
          : '') +
        `Legitimate probe traffic stayed available throughout, so the resiliency score reflects the ` +
        `protection blocking this attack shape — not the target failing.</div>`
      : '';

  const riskPill = pill(risk.label, RISK_PILL[risk.cls as keyof typeof RISK_PILL] ?? 'neutral');
  const mitPill = pill(mit.label, MIT_PILL[mit.cls as keyof typeof MIT_PILL] ?? 'neutral');

  // WRS components (0–1), coloured by band.
  const wrsBars = hbarsSvg(
    [
      {
        label: `Detection${w.estimated ? ' *' : ''}`,
        value: w.detection,
        display: w.detection.toFixed(2),
      },
      {
        label: `Mitigation${w.estimated ? ' *' : ''}`,
        value: w.mitigation,
        display: w.mitigation.toFixed(2),
      },
      { label: 'Availability', value: w.availability, display: w.availability.toFixed(2) },
      { label: 'Collateral', value: w.collateral, display: w.collateral.toFixed(2) },
    ],
    { max: 1, barColor: (v) => scoreColor(v * 100) },
  );

  // Latency percentiles (ms), single hue.
  const latMax = Math.max(g.latencyMs.p99, run.probe.latencyMs.p99, 1) * 1.1;
  const genLat = hbarsSvg(
    [
      { label: 'p50', value: g.latencyMs.p50, display: `${g.latencyMs.p50} ms` },
      { label: 'p95', value: g.latencyMs.p95, display: `${g.latencyMs.p95} ms` },
      { label: 'p99', value: g.latencyMs.p99, display: `${g.latencyMs.p99} ms` },
    ],
    { max: latMax },
  );
  const probeLat = hbarsSvg(
    [
      { label: 'p50', value: run.probe.latencyMs.p50, display: `${run.probe.latencyMs.p50} ms` },
      { label: 'p95', value: run.probe.latencyMs.p95, display: `${run.probe.latencyMs.p95} ms` },
      { label: 'p99', value: run.probe.latencyMs.p99, display: `${run.probe.latencyMs.p99} ms` },
    ],
    { max: latMax, color: REPORT_COLORS.good },
  );

  const ttRow = (label: string, v: number | undefined, unit: string): string =>
    v != null ? `<tr><th>${label}</th><td>${v}${unit}</td></tr>` : '';

  return (
    docHead(`ShieldTest report — ${campaign.name}`) +
    coverBand(
      `Campaign resilience report — ${campaign.name}`,
      `Run ${run.runId.slice(0, 8)} · generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    ) +
    `<p class="lead">${summary}</p>` +
    (kill ? `<div class="callout kill">🛑 ${esc(run.statusDetail ?? run.status)}</div>` : '') +
    absorbedCallout +
    `<h2>At a glance</h2>
<div class="scorecard">
  <div>${gaugeSvg(w.wrs, { sub: `Grade ${grade}`, color: scoreColor(w.wrs) })}
    <div style="text-align:center;font-size:.75rem;color:${REPORT_COLORS.muted}">WEDOS Resiliency Score</div></div>
  <div>
    <div class="pills">${riskPill} ${mitPill} ${pill(run.status.replace('_', ' '), kill ? 'crit' : 'good')}${w.estimated ? ' ' + pill('WRS estimated', 'neutral') : ''}</div>
    <div class="grid cards" style="margin-top:.7rem">
      ${statCard('Availability', `${avail.toFixed(1)}%`)}
      ${statCard('Configured load', `${configuredRps} req/s`, false)}
      ${statCard('Achieved peak', `${peakRps} req/s`, false)}
      ${statCard('Duration', `${durSec}s`)}
      ${statCard('Requests (ok)', `${g.totalRequests.toLocaleString('en-US')} (${g.successful.toLocaleString('en-US')})`, true)}
    </div>
  </div>
</div>` +
    `<h2>Traffic over time</h2>
<div class="figure"><div class="cap">Generator request rate (req/s) across the run.</div>
  ${timelineSvg(
    tl.map((s) => ({ t: s.t, y: s.rps })),
    {
      yUnit: 'req/s',
      color: REPORT_COLORS.brand,
      fill: REPORT_COLORS.brandFill,
      title: 'request rate',
    },
  )}</div>
<div class="figure"><div class="cap">Legitimate-probe availability (%) across the run — the signal the auto-kill watches.</div>
  ${timelineSvg(
    tl.map((s) => ({ t: s.t, y: s.availPct })),
    {
      yMax: 100,
      yUnit: '% avail',
      color: REPORT_COLORS.good,
      fill: REPORT_COLORS.goodFill,
      title: 'availability',
      height: 150,
    },
  )}</div>` +
    `<h2>Resiliency score breakdown</h2>
<div class="figure"><div class="cap">The four WRS components (0–1). ${w.estimated ? 'Detection & Mitigation (*) are estimated — no protection source reported real timings.' : 'Detection & Mitigation are measured.'}</div>
  ${wrsBars}</div>` +
    (w.estimated
      ? `<div class="callout info">* Without a protection integration, Detection and Mitigation are held constant, so the WRS mostly reflects measured Availability and Collateral damage. Wire a protection source for real TTD/TTM (see methodology §3.2).</div>`
      : '') +
    (run.protection
      ? `<div class="callout info"><b>Protection (measured):</b> source <b>${esc(run.protection.source ?? '—')}</b> · Time-to-detect <b>${run.protection.detectionTimeSec}s</b> · Time-to-mitigate <b>${run.protection.mitigationTimeSec}s</b>. The scores above are measured, not estimated.</div>`
      : '') +
    `<h2>Latency profile</h2>
<div class="two-col">
  <div class="figure"><div class="cap">Load generator latency</div>${genLat}</div>
  <div class="figure"><div class="cap">Legitimate probe latency</div>${probeLat}</div>
</div>` +
    (run.baselineDelta
      ? `<div class="callout ${run.baselineDelta.availabilityDeltaPct < 0 || run.baselineDelta.latencyP95DeltaMs > 0 ? 'warn' : 'info'}">
    <b>Degradation under load vs baseline:</b> Δ p50 ${run.baselineDelta.latencyP50DeltaMs} ms · Δ p95 ${run.baselineDelta.latencyP95DeltaMs} ms · Δ availability ${run.baselineDelta.availabilityDeltaPct} pts
    ${run.baseline ? `<span class="muted">(baseline: ${run.baseline.availabilityPct}% avail, p50 ${run.baseline.latencyMs.p50} ms / p95 ${run.baseline.latencyMs.p95} ms over ${run.baseline.samples} samples).</span>` : ''}</div>`
      : '') +
    (run.acceptance
      ? `<h2>SLO verdict</h2><p>${pill(run.acceptance.verdict, run.acceptance.verdict === 'PASS' ? 'good' : 'crit')}</p>${
          run.acceptance.failures.length
            ? `<ul>${run.acceptance.failures.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
            : '<p class="muted">All acceptance criteria met.</p>'
        }`
      : '') +
    remediationsHtml(deriveRemediations(campaign, run)) +
    `<h2>Run detail</h2>
<table class="kvs">
 <tr><th>Campaign</th><td>${esc(campaign.name)} <span class="muted">(${campaign.id})</span></td></tr>
 <tr><th>Target</th><td>${esc(campaign.target)}</td></tr>
 <tr><th>Vector</th><td>${campaign.vector} (bounded application HTTP)</td></tr>
 <tr><th>Author / Approver</th><td>${esc(campaign.createdBy)} / ${esc(campaign.approvedBy ?? '—')}</td></tr>
 <tr><th>Requests (success / fail)</th><td>${g.totalRequests.toLocaleString('en-US')} (${g.successful.toLocaleString('en-US')} / ${g.failed.toLocaleString('en-US')})</td></tr>
 ${
   g.failed > 0
     ? `<tr><th>Failure breakdown</th><td>${rejectedByEdge.toLocaleString('en-US')} rejected by the edge (4xx/5xx) · ${noResponse.toLocaleString('en-US')} no response (rate-limited / timed out)${
         Object.keys(errorsByName).length
           ? ` <span class="muted">[${Object.entries(errorsByName)
               .map(([k, n]) => `${esc(k)}×${n}`)
               .join(', ')}]</span>`
           : ''
       }</td></tr>`
     : ''
 }
 <tr><th>Configured / achieved rate</th><td>${configuredRps} req/s configured · ${g.actualRps} req/s effective · ${peakRps} req/s peak</td></tr>
 <tr><th>Effective RPS</th><td>${g.actualRps}</td></tr>
 <tr><th>Probe availability</th><td>${run.probe.available}/${run.probe.samples} samples · ${run.probe.errorRate5xx}% 5xx</td></tr>
</table>` +
    (tt
      ? `<h3>Target host telemetry (peak under load)</h3><table class="kvs"><tr><th>Samples</th><td>${tt.samples}</td></tr>${ttRow('CPU', tt.cpuPctMax, '%')}${ttRow('Conntrack', tt.conntrackMax, '')}${ttRow('NIC RX', tt.nicRxMbpsMax, ' Mbit/s')}${ttRow('NIC TX', tt.nicTxMbpsMax, ' Mbit/s')}</table><p class="muted">Host-side counters pulled from the target's metrics endpoint during the run (inbound measurement only).</p>`
      : '') +
    (run.posture
      ? `<h3>Protection posture (inferred)</h3><table class="kvs">
 <tr><th>WAF</th><td>${run.posture.waf ? 'detected' : 'not detected'}</td></tr>
 <tr><th>CDN</th><td>${run.posture.cdn ? 'detected' : 'not detected'}</td></tr>
 <tr><th>Rate limiting</th><td>${run.posture.rateLimiting ? 'detected' : 'not detected'}</td></tr>
 <tr><th>Load balancer</th><td>${run.posture.loadBalancer ? 'detected' : 'not detected'}</td></tr>
 <tr><th>HSTS / headers</th><td>${run.posture.hsts ? 'enabled' : 'not set'} · ${run.posture.securityHeaders.join(', ') || '—'}</td></tr>
</table><p class="muted">Inferred passively from the legitimate probe's own responses (no scanning).</p>`
      : '') +
    `<p class="muted" style="margin-top:2rem">Traceable report — WEDOS internal use only. Bounded application HTTP generator (GET/POST, rate-capped, allowlisted); no volumetric, amplification or spoofing vector is implemented by this control plane. See <em>docs/assessment-methodology.md</em>.</p>` +
    DOC_TAIL
  );
}
