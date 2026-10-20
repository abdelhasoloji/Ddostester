import { htmlEscape as esc } from '../../util/text.js';
import { assessDrs } from './scoring.js';
import type { DrsRevision } from './model.js';
export function drsReport(r: DrsRevision) {
  return {
    schema: 'shieldtester.drs.report/v1',
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
export function drsReportHtml(r: DrsRevision): string {
  const report = drsReport(r),
    a = report.assessment;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ShieldTester DRS assessment</title><style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#15213a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cfd7e5;padding:9px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:16px}h1,h2{color:#093774}</style><h1>ShieldTester · DRS ${esc(r.reference.standardVersion)}</h1><p>${esc(a.label)}</p><p><b>${esc(a.status)} · ${a.score ?? 'No usable score'}</b> · terminal level ${a.terminalLevel ?? '—'} / ${esc(a.terminalOutcome)}</p><p>Revision ${r.number} · engine ${esc(r.reference.engineVersion)} · interpretation ${esc(r.reference.interpretationProfile)}</p><p>Catalogue ${esc(r.reference.catalogueHash)} · plan ${esc(r.planHash ?? '')}</p><h2>Baseline diagnostic (not qualified evidence)</h2><pre>${esc(JSON.stringify(report.baselineDiagnostic, null, 2))}</pre><h2>Coverage</h2><table><tr><th>Level</th><th>Total</th><th>Passed</th><th>Failed</th><th>Unknown</th><th>Excluded</th><th>Outcome</th></tr>${a.levels.map((l) => `<tr><td>${l.level}</td><td>${l.total}</td><td>${l.passed}</td><td>${l.failed}</td><td>${l.inconclusive}</td><td>${l.excluded}</td><td>${l.outcome}</td></tr>`).join('')}</table><h2>Capacity envelope this plan was bounded by</h2>${
    r.plan.capacity
      ? `<p>Rate <b>${r.plan.capacity.maxRps.toLocaleString()} rps</b> · concurrency <b>${r.plan.capacity.maxConcurrency.toLocaleString()}</b> · <b>${r.plan.capacity.agents}</b> admitted agent(s), bounded by <b>${esc(r.plan.capacity.limitedBy.rps)}</b> (rate) and <b>${esc(r.plan.capacity.limitedBy.concurrency)}</b> (concurrency), assessed ${esc(r.plan.capacity.assessedAt)}.</p>${
          r.plan.capacity.warnings.length
            ? `<ul>${r.plan.capacity.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
            : ''
        }`
      : '<p>No measured envelope applied: the budgets are the campaign request. Calibrate an agent to bound a plan by fleet capacity.</p>'
  }<h2>Archived requirements versus recorded evidence</h2>${
    a.requirementGaps.length
      ? `<table><tr><th>Vector</th><th>Level</th><th>Dimension</th><th>Required</th><th>Recorded</th><th>Met</th></tr>${a.requirementGaps
          .map(
            (g) =>
              `<tr><td>${esc(g.vectorId)}</td><td>${g.level}</td><td>${esc(g.dimension)}</td><td>${esc(g.required)}</td><td>${esc(g.achieved)}</td><td>${g.met ? 'yes' : '<b>no</b>'}</td></tr>`,
          )
          .join('')}</table>`
      : '<p>No archived load, source or persistence requirement applies to the evaluated vectors.</p>'
  }<h2>Reservations</h2><ul>${a.reservations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><h2>Scope and instrumentation</h2><pre>${esc(JSON.stringify({ services: r.plan.services, architecture: r.plan.architecture, sources: r.plan.sources, protection: r.plan.protectionConfiguration, versions: r.plan.componentVersions }, null, 2))}</pre><h2>Requested and observed conditions, user impact and recovery</h2><pre>${esc(
    JSON.stringify(
      r.proofs.map((p) => ({ provenance: p.provenance, hash: p.hash, ...p.data })),
      null,
      2,
    ),
  )}</pre><h2>Existing run and synthetic-lab observations (diagnostic only)</h2><pre>${esc(JSON.stringify(r.attachments ?? [], null, 2))}</pre><h2>Verdicts and historical attempts</h2><pre>${esc(JSON.stringify(a.conclusions, null, 2))}</pre><h2>Reference anomalies and interpretation</h2><pre>${esc(JSON.stringify(a.ambiguities, null, 2))}</pre><h2>Reproducibility</h2><p>Proof archive ${esc(a.proofHash)}. Download JSON with the complete frozen plan, source reference and evidence chain to reproduce this calculation. No measured-load multiplier is applied.</p></html>`;
}

export interface DrsComparison {
  a: {
    revision: number;
    status: string;
    score: number | null;
    terminalLevel: number | null;
    terminalOutcome: string;
    proofs: number;
  };
  b: {
    revision: number;
    status: string;
    score: number | null;
    terminalLevel: number | null;
    terminalOutcome: string;
    proofs: number;
  };
  deltas: {
    statusChanged: boolean;
    levelChange: number;
    proofDelta: number;
    gapsResolved: { vectorId: string; dimension: string }[];
    gapsRemaining: { vectorId: string; dimension: string }[];
    gapsRegressed: { vectorId: string; dimension: string }[];
  };
}

/**
 * Compare two frozen revisions of the same assessment intent. The useful question after a
 * protection change is not "what is the score" but "which archived requirement is now met,
 * which is still not, and which regressed".
 */
export function compareDrsReports(
  a: ReturnType<typeof drsReport>,
  b: ReturnType<typeof drsReport>,
): DrsComparison {
  const key = (g: { vectorId: string; dimension: string }) => `${g.vectorId}|${g.dimension}`;
  const gapsOf = (r: ReturnType<typeof drsReport>) => r.assessment.requirementGaps ?? [];
  const ga = new Map(gapsOf(a).map((g) => [key(g), g]));
  const gb = new Map(gapsOf(b).map((g) => [key(g), g]));
  const resolved: { vectorId: string; dimension: string }[] = [];
  const remaining: { vectorId: string; dimension: string }[] = [];
  const regressed: { vectorId: string; dimension: string }[] = [];
  for (const [k, g] of gb) {
    const before = ga.get(k);
    if (g.met && before && !before.met)
      resolved.push({ vectorId: g.vectorId, dimension: g.dimension });
    if (!g.met) remaining.push({ vectorId: g.vectorId, dimension: g.dimension });
  }
  for (const [k, g] of ga) {
    const after = gb.get(k);
    if (g.met && after && !after.met)
      regressed.push({ vectorId: g.vectorId, dimension: g.dimension });
  }
  const side = (r: ReturnType<typeof drsReport>) => ({
    revision: r.revision,
    status: r.assessment.status,
    score: r.assessment.score,
    terminalLevel: r.assessment.terminalLevel,
    terminalOutcome: r.assessment.terminalOutcome,
    proofs: r.proofs.length,
  });
  return {
    a: side(a),
    b: side(b),
    deltas: {
      statusChanged: a.assessment.status !== b.assessment.status,
      levelChange: (b.assessment.terminalLevel ?? 0) - (a.assessment.terminalLevel ?? 0),
      proofDelta: b.proofs.length - a.proofs.length,
      gapsResolved: resolved,
      gapsRemaining: remaining,
      gapsRegressed: regressed,
    },
  };
}
