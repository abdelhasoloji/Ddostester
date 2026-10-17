import type { BenchRun } from '../bench/model.js';
import type { Campaign } from '../campaigns/model.js';
import { htmlEscape as esc } from '../../util/text.js';
import { assessDrs } from './scoring.js';
import type { DrsRevision } from './model.js';
function scenarioResults(
  journey: Campaign['syntheticJourney'],
  attachments: DrsRevision['attachments'] = [],
) {
  return (
    journey?.steps.map((s, i) => {
      const archived = attachments?.find(
        (a) => a.kind === 'network-bench' && a.sourceId === s.runId,
      )?.source as BenchRun | undefined;
      return {
        vectorId: s.vectorId ?? null,
        name: s.name ?? s.scenarioId,
        level: s.level ?? null,
        execution: s.execution ?? 'LAB_MEASUREMENT',
        generator: s.execution === 'SIMULATION' ? null : s.scenarioId,
        reference: journey.definition.entries?.[i]?.referenceVector ?? null,
        result:
          s.result ??
          (archived?.status === 'COMPLETED'
            ? {
                kind: 'LAB_MEASUREMENT' as const,
                outcome: archived.verdict?.outcome ?? 'COMPLETED',
                receivedBps: archived.verdict?.target?.avgBps ?? null,
                acceptedConnections: archived.verdict?.connections?.accepted ?? null,
                runId: archived.id,
                drsScoreEligible: false as const,
              }
            : {
                kind: 'NOT_EVALUATED',
                outcome: 'NOT_EXECUTED',
                receivedBps: null,
                drsScoreEligible: false,
              }),
      };
    }) ?? []
  );
}
function executionHtml(
  journey: Campaign['syntheticJourney'],
  attachments: DrsRevision['attachments'],
) {
  if (!journey) return '';
  const rows = scenarioResults(journey, attachments);
  return `<h2>Synthetic execution</h2><p>${esc(journey.state)} · objective ${journey.definition.reference.targetLevel} · interval ${journey.definition.reference.intervalSec}s</p><p>${esc(journey.reason ?? 'Bounded laboratory shapes and reference lifecycle simulations; no qualified DRS score')}</p><table aria-label="Scenario results"><tr><th>Level / source</th><th>Scenario</th><th>Execution</th><th>Result</th><th>Observation</th></tr>${rows.map((row) => `<tr data-vector-id="${esc(row.vectorId ?? 'legacy')}"><td>${row.level ?? '—'} / ${esc(row.reference?.source_vector_id ?? 'legacy')}</td><td>${esc(row.name)}</td><td>${row.execution === 'SIMULATION' ? 'SIMULATION · no traffic' : 'LAB MEASUREMENT · partial shape'}</td><td>${esc(row.result.outcome)}</td><td>${row.result.kind === 'SIMULATION' ? 'No measured load or service behavior' : row.result.receivedBps !== null ? `${row.result.receivedBps} bit/s received` : 'acceptedConnections' in row.result && row.result.acceptedConnections != null ? `${row.result.acceptedConnections} connections accepted` : 'Not measured'}</td></tr>`).join('')}</table><details><summary>Frozen reference and execution archive</summary><pre>${esc(JSON.stringify(journey, null, 2))}</pre></details>`;
}
export function drsReport(
  r: DrsRevision,
  clientWorkspace?: Campaign['clientWorkspace'],
  syntheticJourney?: Campaign['syntheticJourney'],
) {
  return {
    schema: 'shieldtester.drs.report/v1',
    clientWorkspace: clientWorkspace ?? null,
    syntheticJourney: syntheticJourney ?? null,
    scenarioResults: scenarioResults(syntheticJourney, r.attachments),
    attachments: r.attachments ?? [],
    baselineDiagnostic: r.baselineDiagnostic ?? null,
    revision: r.number,
    revisionId: r.id,
    reference: r.reference,
    planHash: r.planHash,
    scope: r.plan.services,
    architecture: r.plan.architecture,
    instrumentation: r.plan.sources,
    plan: r.plan,
    trace: r.trace,
    assessment: assessDrs(r),
    proofs: r.proofs.map((p) => ({
      ...p,
      measurements: {
        requested_load: p.data.requested_load,
        emitted_load: p.data.points
          .filter(
            (point) => r.plan.sources.find((s) => s.id === point.sourceId)?.role === 'generator',
          )
          .map((point) => ({ sourceId: point.sourceId, load: point.load ?? null })),
        received_load: p.data.points
          .filter((point) => r.plan.sources.find((s) => s.id === point.sourceId)?.role === 'entry')
          .map((point) => ({ sourceId: point.sourceId, actual_received_load: point.load ?? null })),
        latency_baseline: p.data.latency_baseline,
        latency_during_test: p.data.latency_during_test,
      },
    })),
  };
}
export function drsReportHtml(
  r: DrsRevision,
  clientWorkspace?: Campaign['clientWorkspace'],
  syntheticJourney?: Campaign['syntheticJourney'],
): string {
  const report = drsReport(r, clientWorkspace, syntheticJourney),
    a = report.assessment;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ShieldTester DRS assessment</title><style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#15213a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cfd7e5;padding:9px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:16px}h1,h2{color:#093774}</style><h1>ShieldTester · DRS ${esc(r.reference.standardVersion)}</h1><p>${esc(a.label)}</p><p><b>${esc(a.status)} · ${a.score ?? 'No usable score'}</b> · terminal level ${a.terminalLevel ?? '—'} / ${esc(a.terminalOutcome)}</p><p>Revision ${r.number} · engine ${esc(r.reference.engineVersion)} · interpretation ${esc(r.reference.interpretationProfile)}</p><p>Catalogue ${esc(r.reference.catalogueHash)} · plan ${esc(r.planHash ?? '')}</p>${executionHtml(syntheticJourney, r.attachments)}<h2>Client scope snapshot</h2><pre>${esc(JSON.stringify(report.clientWorkspace, null, 2))}</pre><h2>Baseline diagnostic (not qualified evidence)</h2><pre>${esc(JSON.stringify(report.baselineDiagnostic, null, 2))}</pre><h2>Coverage</h2><table><tr><th>Level</th><th>Total</th><th>Passed</th><th>Failed</th><th>Unknown</th><th>Excluded</th><th>Outcome</th></tr>${a.levels.map((l) => `<tr><td>${l.level}</td><td>${l.total}</td><td>${l.passed}</td><td>${l.failed}</td><td>${l.inconclusive}</td><td>${l.excluded}</td><td>${l.outcome}</td></tr>`).join('')}</table><h2>Reservations</h2><ul>${a.reservations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><h2>Scope and instrumentation</h2><pre>${esc(JSON.stringify({ services: r.plan.services, architecture: r.plan.architecture, sources: r.plan.sources, protection: r.plan.protectionConfiguration, versions: r.plan.componentVersions }, null, 2))}</pre><h2>Requested and observed conditions, user impact and recovery</h2><pre>${esc(
    JSON.stringify(
      r.proofs.map((p) => ({ provenance: p.provenance, hash: p.hash, ...p.data })),
      null,
      2,
    ),
  )}</pre><h2>Existing run and synthetic-lab observations (diagnostic only)</h2><pre>${esc(JSON.stringify(r.attachments ?? [], null, 2))}</pre><h2>Verdicts and historical attempts</h2><pre>${esc(JSON.stringify(a.conclusions, null, 2))}</pre><h2>Reference anomalies and interpretation</h2><pre>${esc(JSON.stringify(a.ambiguities, null, 2))}</pre><h2>Reproducibility</h2><p>Proof archive ${esc(a.proofHash)}. Download JSON with the complete frozen plan, source reference and evidence chain to reproduce this calculation. No measured-load multiplier is applied.</p></html>`;
}
