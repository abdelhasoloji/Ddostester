import type { Campaign, TargetRequirement } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { fleetCounterCoverage } from '../fleet/summary.js';
import { renderFleetMeasurementHtml } from './fleet-measurement.js';
import { summarizeTargetTelemetry } from '../target-telemetry/provider.js';
import { htmlEscape as esc } from '../../util/text.js';
import { hostOf } from '../../util/net.js';
import { riskLevel } from './compliance.js';
import { computeAbsorption, normalizeErrorMap } from './absorption.js';
import { describeEdgeError } from '../posture/edge-error.js';
import { scenarioMeanRps } from '../campaigns/calibration.js';
import { fleetCpuContention, computeConfidence } from './confidence.js';
import { assessVector, type VectorVerdict } from './assessment.js';
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

const REQUIREMENT_LABEL: Record<TargetRequirement, string> = {
  h2: 'HTTP/2 endpoint',
  waf: 'WAF / bot-management',
  cache: 'edge cache',
  dynamic: 'dynamic (uncacheable) endpoint',
};

/**
 * "Template applicability" block: a line's source template declares the target
 * features it needs (`requires`). When the target lacks one — established from
 * the recon posture captured at instantiation — a benign result is **N/A**, not
 * evidence the target resisted. Surfacing this keeps a report honest: a WAF-
 * evasion line reading "held" against a target with no WAF proves nothing. Empty
 * (no `requires`) → no block. Same mapping as scripts/template-matrix.mjs.
 */
export function requiresApplicabilityHtml(campaign: Campaign, run: CampaignRun): string {
  const requires = campaign.requires;
  if (!requires?.length) return '';
  const rp = campaign.reconPosture;
  // null = "not recorded" (a campaign created before posture capture, for which
  // run.posture only knows waf/cdn and a seeded surface hints at dynamic).
  const has: Record<TargetRequirement, boolean | null> = rp
    ? { h2: rp.h2, waf: rp.waf, cache: rp.cache, dynamic: rp.dynamic }
    : {
        h2: null,
        waf: run.posture ? !!run.posture.waf : null,
        cache: run.posture ? !!run.posture.cdn : null,
        dynamic: (campaign.endpoints?.length ?? 0) > 0 ? true : null,
      };
  const rows = requires
    .map((r) => {
      const label = REQUIREMENT_LABEL[r] ?? r;
      const state = has[r];
      const cell =
        state === true
          ? `${pill('applies', 'good')} target exhibits ${esc(label)}`
          : state === false
            ? `${pill('N/A', 'warn')} target has no ${esc(label)} — a benign result here is not resistance`
            : `${pill('not recorded', 'neutral')} target posture for ${esc(label)} was not captured for this run`;
      return `<tr><th>${esc(label)}</th><td>${cell}</td></tr>`;
    })
    .join('');
  const anyNa = requires.some((r) => has[r] === false);
  return (
    `<h3>Template applicability</h3><table class="kvs">${rows}</table>` +
    `<p class="muted">This line's template needs the feature(s) above to produce a meaningful verdict.${
      anyNa
        ? ' Where the target lacks one, the corresponding result is <b>N/A</b> — not proof the target resisted.'
        : ''
    }</p>`
  );
}

export function renderCampaignReportHtml(campaign: Campaign, run: CampaignRun): string {
  const g = run.generator;
  const iotProfile = g.config?.iotProfile;
  const counterCoverage = g.fleet ? fleetCounterCoverage(g.fleet.shards) : undefined;
  const partialCounters =
    counterCoverage && counterCoverage.reportedAgents < counterCoverage.expectedAgents;
  const w = run.wrs;
  const tl = run.timeline ?? [];
  const tt = run.targetTelemetry?.length ? summarizeTargetTelemetry(run.targetTelemetry) : null;
  const avail = availabilityPct(run);
  const risk = riskLevel(run);
  const peakRps = tl.length
    ? Math.max(...tl.map((s) => s.rps), Math.round(g.actualRps))
    : Math.round(g.actualRps);
  const durSec = tl.length ? Math.max(...tl.map((s) => s.t)) : campaign.maxDurationSec;
  const grade = w.level;

  const configuredRps = campaign.maxRps;
  const statusCounts = g.statusCounts ?? {};
  const errorsByName = g.errors ?? {};
  // Collapse the per-request error keys (cache-busted URLs make each unique) into
  // their underlying error classes, so the breakdown reads "context deadline
  // exceeded ×63,133" instead of thousands of ×1 lines.
  const errorBreakdown = normalizeErrorMap(errorsByName);
  const rejectedByEdge = Object.entries(statusCounts)
    .filter(([b]) => b !== '2xx' && b !== '3xx')
    .reduce((s, [, n]) => s + n, 0); // 4xx/5xx — the target answered, refusing the request
  const noResponse = Object.values(errorsByName).reduce((s, n) => s + n, 0); // timeouts / conn errors

  // Protection absorption (configured → offered → origin, + % absorbed) and
  // measurement confidence (was OUR generator the bottleneck?), both shared with
  // the /metrics gauges and the in-app widgets via the same helpers.
  const absorption =
    run.absorption ??
    computeAbsorption({
      configuredRps,
      // Delivery is measured against the scenario's intended mean, not its peak
      // (a wave/ramp's mean is below its peak). Live runs carry this in
      // run.absorption; recompute it here for older runs that predate it.
      expectedRps: Math.round(scenarioMeanRps(campaign.maxRps, campaign.scenario)),
      achievedRps: g.actualRps,
      totalRequests: g.totalRequests,
      successful: g.successful,
      failed: g.failed,
      durationSec: durSec,
    });
  const confidence =
    run.confidence ??
    computeConfidence({
      unfinalizedRequests: g.unfinalizedRequests,
      hardStopped: g.hardStopped,
      fleetIncomplete: g.fleet?.measurementComplete === false,
      fleetCpuContention: fleetCpuContention(g.fleet?.shards),
    });

  // The faithful verdict — the SAME assessment engine the suite report and the
  // detail page use, so all three tell one story. Prefer the stored assessment;
  // recompute (with the absorption above) for older runs that predate it.
  const assessment =
    run.assessment ??
    assessVector(
      { ...run, absorption, confidence },
      {
        shape: campaign.name,
        drs: /DRS\s*([0-9])/i.exec(campaign.name)?.[1] ?? '—',
        status: run.status,
        vector: campaign.vector,
      },
    );

  // Management summary — led by the engine's verdict + faithful observation.
  const kill = run.status !== 'COMPLETED';
  const summary =
    `Under a bounded HTTP load configured at up to <b>${configuredRps} req/s</b> for <b>${durSec}s</b> against ` +
    `<b>${esc(hostOf(campaign.target))}</b>, the run scored <b>WRS ${w.wrs} (${grade})</b> — verdict ` +
    `<b>${assessment.verdict}</b>, RiskLevel <b>${risk.label}</b>. ${esc(assessment.observation)}` +
    (run.baselineDelta && run.baseline?.observation?.complete !== false
      ? ` Under load, p95 latency shifted by ${run.baselineDelta.latencyP95DeltaMs} ms vs the pre-load baseline.`
      : '');

  // A callout driven by the verdict: an under-delivered run is INCONCLUSIVE (a
  // generator-side shortfall, NOT the target absorbing); an edge that rejected or
  // held the load while legitimate traffic stayed up is the protection working.
  const verdictCallout = kill
    ? ''
    : assessment.verdict === 'inconclusive'
      ? `<div class="callout warn"><b>Inconclusive — not a valid test at the target rate.</b> ${esc(assessment.caveats.join(' '))}</div>`
      : (assessment.mechanism === 'rejected' ||
            assessment.mechanism === 'tarpitted' ||
            assessment.mechanism === 'blocked') &&
          avail >= 99
        ? `<div class="callout info"><b>The target's edge handled the load.</b> ` +
          `Of ${g.totalRequests.toLocaleString('en-US')} bounded requests, ` +
          `<b>${g.successful.toLocaleString('en-US')}</b> succeeded — ` +
          `${rejectedByEdge.toLocaleString('en-US')} were rejected by the edge (4xx/5xx) and ` +
          `${noResponse.toLocaleString('en-US')} got no response (rate-limited / connection held). ` +
          `Legitimate probe traffic stayed available throughout.</div>`
        : '';

  const riskPill = pill(risk.label, RISK_PILL[risk.cls as keyof typeof RISK_PILL] ?? 'neutral');
  const VERDICT_PILL: Record<VectorVerdict, 'good' | 'warn' | 'crit' | 'neutral'> = {
    held: 'good',
    partial: 'warn',
    inconclusive: 'neutral',
    breached: 'crit',
  };
  const verdictPill = pill(assessment.verdict, VERDICT_PILL[assessment.verdict]);

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
  const genLat =
    g.latencySampleCount === 0
      ? '<p class="muted">Generator latency unknown — no finalized latency samples.</p>'
      : hbarsSvg(
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
    (iotProfile
      ? `<h2>Synthetic IoT profile</h2><p>Profile ${esc(iotProfile.id)} · seed ${esc(String(iotProfile.seed))} · device index ${esc(String(iotProfile.deviceIndex))}. Deterministic HTTP identity, payload and think-time; request timing and response outcomes are not reproducible firmware or network emulation.</p>`
      : '') +
    (kill ? `<div class="callout kill">🛑 ${esc(run.statusDetail ?? run.status)}</div>` : '') +
    (confidence.degraded
      ? `<div class="callout warn">⚠ <b>Measurement degraded — this WRS may be understated.</b> ${esc(confidence.reasons.join(' '))}</div>`
      : '') +
    verdictCallout +
    renderFleetMeasurementHtml(run) +
    (g.fleet
      ? `<h2>Fleet evidence</h2><p>Measurement: ${g.fleet.measurementComplete ? 'complete' : 'incomplete'}. Percentiles use merged histogram bucket upper bounds; agent p95 values are not averaged.</p><table><thead><tr><th>Agent</th><th>State</th><th>Private pod IP</th><th>Pod UID</th></tr></thead><tbody>${g.fleet.shards.map((s) => `<tr><td>${esc(s.agentId)}</td><td>${esc(s.state)}</td><td>${esc(String(s.result?.podIp ?? 'unknown'))}</td><td>${esc(String(s.result?.podUid ?? 'unknown'))}</td></tr>`).join('')}</tbody></table>`
      : '') +
    `<h2>At a glance</h2>
<div class="scorecard">
  <div>${gaugeSvg(w.wrs, { sub: `Grade ${grade}`, color: scoreColor(w.wrs) })}
    <div style="text-align:center;font-size:.75rem;color:${REPORT_COLORS.muted}">WEDOS Resiliency Score</div></div>
  <div>
    <div class="pills">${verdictPill} ${riskPill} ${pill(run.status.replace('_', ' '), kill ? 'crit' : 'good')}${w.estimated ? ' ' + pill('WRS estimated', 'neutral') : ''}</div>
    <div class="grid cards" style="margin-top:.7rem">
      ${statCard('Availability', `${avail.toFixed(1)}%`)}
      ${statCard('Configured load', `${configuredRps} req/s`, false)}
      ${statCard('Achieved peak', `${peakRps} req/s`, false)}
      ${statCard('Duration', `${durSec}s`)}
      ${statCard(partialCounters ? 'Reported requests (partial)' : 'Requests (ok)', partialCounters && !counterCoverage.reportedAgents ? 'unknown' : `${g.totalRequests.toLocaleString('en-US')} (${g.successful.toLocaleString('en-US')})`, true)}
    </div>
  </div>
</div>` +
    `<h2>Protection absorption</h2>
<p class="muted">Generator observations${partialCounters ? ' from received final agent reports only; missing agents have unknown counters and fractions' : ''}. Successful responses may come from cache or edge; failures do not by themselves prove protection absorption.</p>
<div class="grid cards">
  ${statCard('Configured', `${absorption.configuredRps} req/s`, false)}
  ${statCard(partialCounters ? 'Reported sent (partial)' : 'Offered (sent)', partialCounters && !counterCoverage.reportedAgents ? 'unknown' : `${absorption.achievedRps.toFixed(1)} req/s`, false)}
  ${statCard(partialCounters ? 'Reported successes (partial)' : 'Successful responses', partialCounters && !counterCoverage.reportedAgents ? 'unknown' : `${absorption.originRps.toFixed(1)} req/s`, false)}
  ${statCard(partialCounters ? 'Reported failure fraction (partial)' : 'Generator failures', partialCounters && !counterCoverage.reportedAgents ? 'unknown' : `${absorption.absorbedPct}%`, absorption.absorbedPct >= 20)}
</div>
<p class="muted" style="margin-top:.6rem">Observed HTTP failures, transport failures and offered-rate shortfall:</p>
<div class="grid cards">
  ${statCard('HTTP failures (4xx/5xx)', `${(absorption.rejectedRatio * 100).toFixed(1)}%`, false)}
  ${statCard('Transport failures (timeout/abort)', `${(absorption.tarpitRatio * 100).toFixed(1)}%`, absorption.tarpitRatio >= 0.2)}
  ${statCard('Offered shortfall', `${(absorption.offeredShortfall * 100).toFixed(1)}%`, false)}
</div>
<p class="muted" style="font-size:.82rem">HTTP failures and transport failures identify outcomes, not their cause. Edge absorption and origin impact require corroborating telemetry. Offered shortfall indicates generator under-delivery.</p>${
      run.edgeCorroboration
        ? `<div class="callout ${run.edgeCorroboration.agrees ? 'info' : 'warn'}"><b>Bilateral corroboration (${esc(run.edgeCorroboration.source)}):</b> we inferred <b>${Math.round(run.edgeCorroboration.ourAbsorbedRatio * 100)}%</b> absorbed; the edge itself reports <b>${Math.round(run.edgeCorroboration.edgeAbsorbedRatio * 100)}%</b> — ${
            run.edgeCorroboration.agrees
              ? 'the two sides <b>agree</b>, so this absorption is measured evidence, not inference.'
              : `they <b>disagree</b> by ${Math.round(run.edgeCorroboration.agreementDelta * 100)} pts — investigate (measurement gap or partial edge visibility).`
          }</div>`
        : ''
    }` +
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
    (run.baseline?.observation?.complete === false
      ? `<div class="callout warn"><b>Remote baseline incomplete.</b> ${run.baseline.observation.receivedSamples}/${run.baseline.observation.expectedSamples} observations received; target availability and comparison remain uncertain.</div>`
      : '') +
    (run.baselineDelta && run.baseline?.observation?.complete !== false
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
 ${campaign.drsProfileId ? `<tr><th>DRS profile</th><td>${esc(campaign.drsProfileId)} · bounded Fleet functional measurement, not a DRS certification</td></tr>` : ''}
 <tr><th>DRS assessment</th><td>${run.drsAssessment ? `${esc(run.drsAssessment.assessment.label)} · ${esc(run.drsAssessment.assessment.status)} · ${run.drsAssessment.assessment.score ?? 'No usable score'} · standard ${esc(run.drsAssessment.reference.standardVersion)} · revision ${run.drsAssessment.revision}` : 'NOT_EVALUATED — no independent frozen DRS evidence archive. WRS is a separate diagnostic.'}</td></tr>
 <tr><th>Campaign</th><td>${esc(campaign.name)} <span class="muted">(${campaign.id})</span></td></tr>
 <tr><th>Target</th><td>${esc(campaign.target)}</td></tr>
 <tr><th>Vector</th><td>${campaign.vector} (bounded application HTTP)</td></tr>
 <tr><th>Author / Approver</th><td>${esc(campaign.createdBy)} / ${esc(campaign.approvedBy ?? '—')}</td></tr>
 <tr><th>${partialCounters ? 'Reported requests (partial)' : 'Requests (success / fail)'}</th><td>${partialCounters && !counterCoverage.reportedAgents ? 'unknown' : `${g.totalRequests.toLocaleString('en-US')} (${g.successful.toLocaleString('en-US')} / ${g.failed.toLocaleString('en-US')})`}</td></tr>
 ${g.latencyMethod ? `<tr><th>Generator latency aggregation</th><td>${esc(g.latencyMethod)} — ${g.latencyMethod === 'native-rounded-response-times' ? 'native final statistics with rounded response-time buckets' : 'combined observations or histogram upper bounds; phase percentiles are not averaged'}</td></tr>` : ''}
 ${g.finalizedRequests === undefined ? '' : `<tr><th>Finalized / unfinalized HTTP outcomes</th><td>${g.finalizedRequests} / ${g.unfinalizedRequests ?? 'unknown'} — unfinalized attempts have no inferred target receipt or HTTP status</td></tr>`}
 ${counterCoverage ? `<tr><th>Generator counter coverage</th><td>${counterCoverage.reportedAgents}/${counterCoverage.expectedAgents} final reports. Missing counters are unknown; target receipts are independent evidence.</td></tr>` : ''}
 ${
   g.failed > 0
     ? `<tr><th>Failure breakdown</th><td>${rejectedByEdge.toLocaleString('en-US')} rejected by the edge (4xx/5xx) · ${noResponse.toLocaleString('en-US')} no response (rate-limited / timed out)${
         errorBreakdown.length
           ? ` <span class="muted">[${errorBreakdown
               .map((e) => `${esc(e.label)}×${e.count.toLocaleString('en-US')}`)
               .join(', ')}]</span>`
           : ''
       }</td></tr>`
     : ''
 }
 <tr><th>${partialCounters ? 'Configured / reported rate (partial)' : 'Configured / achieved rate'}</th><td>${configuredRps} req/s configured · ${partialCounters && !counterCoverage.reportedAgents ? 'unknown reported rate' : `${g.actualRps} req/s ${partialCounters ? 'reported' : 'effective'}`} · ${peakRps} req/s observed peak</td></tr>
 ${
   run.baseline?.quality
     ? `<tr><th>Baseline diagnostic coverage</th><td>${esc(String(run.baseline.quality.measuredSamples))}/${esc(String(run.baseline.quality.totalSamples))} measurements</td></tr>
 <tr><th>Baseline recent process-window event-loop delay peak</th><td>${run.baseline.quality.peakRecentEventLoopDelayMs == null ? 'unknown' : esc(String(run.baseline.quality.peakRecentEventLoopDelayMs)) + ' ms'}</td></tr>
 <tr><th>Baseline cgroup throttled fraction peak</th><td>${run.baseline.quality.peakThrottledFraction == null ? 'unknown' : esc(String(run.baseline.quality.peakThrottledFraction))}</td></tr>`
     : ''
 }
 ${run.recoveryBeforeRun ? `<tr><th>Recovery before suite step</th><td>${run.recoveryBeforeRun.available && run.recoveryBeforeRun.verified !== false ? 'available' : 'unverified or unavailable'}; ${esc(String(run.recoveryBeforeRun.checks))} checks; ${esc(String(run.recoveryBeforeRun.waitedMs))} ms</td></tr>` : ''}
 ${g.fleet?.startup ? `<tr><th>Fleet generator-start delay</th><td>${g.fleet.startup.firstGeneratorStartDelayMs === null ? 'unknown' : esc(String(g.fleet.startup.firstGeneratorStartDelayMs))} to ${g.fleet.startup.lastGeneratorStartDelayMs === null ? 'unknown' : esc(String(g.fleet.startup.lastGeneratorStartDelayMs))} ms; ${g.fleet.startup.reportedAgents}/${g.fleet.startup.expectedAgents} timestamp observations. Global throughput includes startup; these timestamps do not prove first target arrival.</td></tr>` : ''}
 <tr><th>Probe availability</th><td>${run.probe.available}/${run.probe.samples} samples · ${run.probe.errorRate5xx}% 5xx</td></tr>
 ${
   run.probe.quality
     ? `<tr><th>Probe diagnostic coverage</th><td>${esc(String(run.probe.quality.measuredSamples))}/${esc(String(run.probe.quality.totalSamples))} measurements</td></tr>
 <tr><th>Probe event-loop delay peak</th><td>${run.probe.quality.peakEventLoopDelayMs === null ? 'unknown' : esc(String(run.probe.quality.peakEventLoopDelayMs)) + ' ms'}</td></tr>
 <tr><th>Probe event-loop diagnostic coverage</th><td>${run.probe.quality.eventLoopMeasuredSamples === undefined ? 'unknown' : esc(String(run.probe.quality.eventLoopMeasuredSamples)) + '/' + esc(String(run.probe.quality.totalSamples))}</td></tr>
 <tr><th>Probe recent process-window event-loop delay peak</th><td>${run.probe.quality.peakRecentEventLoopDelayMs == null ? 'unknown' : esc(String(run.probe.quality.peakRecentEventLoopDelayMs)) + ' ms'}</td></tr>
 <tr><th>Probe cgroup throttled fraction peak</th><td>${run.probe.quality.peakThrottledFraction === null ? 'unknown' : esc(String(run.probe.quality.peakThrottledFraction))}</td></tr>
 <tr><th>Diagnostic scope</th><td>Probe process/cgroup during measurement; overlapping intervals are not independent costs.</td></tr>`
     : ''
 }
</table>` +
    (tt
      ? `<h3>Target host telemetry (peak under load)</h3><table class="kvs"><tr><th>Samples</th><td>${tt.samples}</td></tr>${ttRow('Tagged requests received at target', tt.receivedRequestsMax, '')}${ttRow('CPU', tt.cpuPctMax, '%')}${ttRow('Conntrack', tt.conntrackMax, '')}${ttRow('NIC RX', tt.nicRxMbpsMax, ' Mbit/s')}${ttRow('NIC TX', tt.nicTxMbpsMax, ' Mbit/s')}</table><p class="muted">Target-side observations pulled during the run. Missing CPU/NIC fields are unknown, not zero. Receipt completeness: ${tt.receiptComplete === undefined ? 'not provided' : tt.receiptComplete ? 'complete' : 'incomplete'}. Private sources: ${esc((tt.sourceIps ?? []).join(', ') || 'not provided')}.</p>`
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
    requiresApplicabilityHtml(campaign, run) +
    (run.edgeErrors && run.edgeErrors.length
      ? `<h3>Edge-served errors under load</h3>` +
        `<p class="muted">The edge served its OWN error page under load — first-party evidence of the mechanism that engaged (and, for a 5xx origin page, that the origin buckled behind a healthy edge).</p>` +
        `<table class="kvs">` +
        run.edgeErrors
          .map(
            (e) =>
              `<tr><th>${esc(describeEdgeError(e))}</th><td>${[
                e.node ? `node ${esc(e.node)}` : '',
                e.protocol ? esc(e.protocol) : '',
                e.reqId ? `req ${esc(e.reqId)}` : '',
                e.server ? `upstream ${esc(e.server)}` : '',
                e.originIpLeaked
                  ? `<b>origin IP disclosed: ${esc(e.originIpLeaked)}</b> — information-disclosure finding; never targeted (that would bypass the edge)`
                  : '',
              ]
                .filter(Boolean)
                .join(' · ')}</td></tr>`,
          )
          .join('') +
        `</table>`
      : '') +
    `<p class="muted" style="margin-top:2rem">Traceable report — WEDOS internal use only. Bounded application HTTP generator (GET/POST, rate-capped, allowlisted); no volumetric, amplification or spoofing vector is implemented by this control plane. See <em>docs/assessment-methodology.md</em>.</p>` +
    DOC_TAIL
  );
}
