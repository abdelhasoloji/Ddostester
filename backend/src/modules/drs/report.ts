import { htmlEscape as esc } from '../../util/text.js';
import { assessDrs } from './scoring.js';
import type { DrsRevision } from './model.js';
export function drsReport(r: DrsRevision) {
  return {
    schema: 'shieldtester.drs.report/v1',
    attachments: r.attachments ?? [],
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
export function drsReportHtml(r: DrsRevision): string {
  const report = drsReport(r),
    a = report.assessment;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ShieldTester DRS assessment</title><style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#15213a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cfd7e5;padding:9px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:16px}h1,h2{color:#093774}</style><h1>ShieldTester · DRS ${esc(r.reference.standardVersion)}</h1><p>${esc(a.label)}</p><p><b>${esc(a.status)} · ${a.score ?? 'No usable score'}</b> · terminal level ${a.terminalLevel ?? '—'} / ${esc(a.terminalOutcome)}</p><p>Revision ${r.number} · engine ${esc(r.reference.engineVersion)} · interpretation ${esc(r.reference.interpretationProfile)}</p><p>Catalogue ${esc(r.reference.catalogueHash)} · plan ${esc(r.planHash ?? '')}</p><h2>Coverage</h2><table><tr><th>Level</th><th>Total</th><th>Passed</th><th>Failed</th><th>Unknown</th><th>Excluded</th><th>Outcome</th></tr>${a.levels.map((l) => `<tr><td>${l.level}</td><td>${l.total}</td><td>${l.passed}</td><td>${l.failed}</td><td>${l.inconclusive}</td><td>${l.excluded}</td><td>${l.outcome}</td></tr>`).join('')}</table><h2>Reservations</h2><ul>${a.reservations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><h2>Scope and instrumentation</h2><pre>${esc(JSON.stringify({ services: r.plan.services, architecture: r.plan.architecture, sources: r.plan.sources, protection: r.plan.protectionConfiguration, versions: r.plan.componentVersions }, null, 2))}</pre><h2>Requested and observed conditions, user impact and recovery</h2><pre>${esc(
    JSON.stringify(
      r.proofs.map((p) => ({ provenance: p.provenance, hash: p.hash, ...p.data })),
      null,
      2,
    ),
  )}</pre><h2>Existing run and synthetic-lab observations (diagnostic only)</h2><pre>${esc(JSON.stringify(r.attachments ?? [], null, 2))}</pre><h2>Verdicts and historical attempts</h2><pre>${esc(JSON.stringify(a.conclusions, null, 2))}</pre><h2>Reference anomalies and interpretation</h2><pre>${esc(JSON.stringify(a.ambiguities, null, 2))}</pre><h2>Reproducibility</h2><p>Proof archive ${esc(a.proofHash)}. Download JSON with the complete frozen plan, source reference and evidence chain to reproduce this calculation. No measured-load multiplier is applied.</p></html>`;
}
