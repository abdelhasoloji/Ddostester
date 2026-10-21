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
    // A synthetic amplifier run establishes nothing about the target, so once its validation is
    // sealed it has no assessment and no verdict; the report carries the validation instead.
    // A synthetic-lab plan that has not run yet still renders as a frozen plan.
    assessment: r.synthetic ? null : assessDrs(r),
    synthetic: r.synthetic ?? null,
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
  const report = drsReport(r);
  if (report.synthetic) {
    const v = report.synthetic;
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ShieldTester — synthetic engine validation</title><style>body{font:15px system-ui;max-width:900px;margin:40px auto;padding:20px;color:#15213a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cfd7e5;padding:9px;text-align:left}h1{color:#093774}.banner{background:#fdf3e3;border-left:4px solid #b26a00;padding:12px 14px;margin:16px 0}</style><h1>SYNTHETIC — NON-CERTIFYING</h1><div class="banner">This run validated the instrument, not the target. No traffic was sent to the client target, no level is qualified and no verdict is produced.</div><h2>Claimed versus produced</h2><table><tr><th></th><th>Claimed</th><th>Produced</th></tr><tr><td>Rate</td><td>${v.claimed.rps} rps</td><td>${v.produced.rps} rps</td></tr><tr><td>Concurrency</td><td>${v.claimed.concurrency}</td><td>${v.produced.concurrency}</td></tr><tr><td>Duration</td><td>${v.claimed.durationSec}s</td><td>${v.produced.durationSec}s</td></tr></table><p>Fidelity: <b>${(v.fidelity * 100).toFixed(1)} %</b></p><h2>Controls</h2><table><tr><th>Control</th><th>Result</th><th>Detail</th></tr>${v.controls.map((c) => `<tr><td>${esc(c.id)}</td><td>${c.ok ? 'ok' : 'not ok'}</td><td>${esc(c.detail)}</td></tr>`).join('')}</table><p>Sealed ${esc(v.sealedAt)} · ${esc(v.hash)}</p></body></html>`;
  }
  const a = report.assessment;
  if (!a)
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ShieldTester — no verdict yet</title><body style="font:15px system-ui;max-width:700px;margin:40px auto"><h1>No verdict yet</h1><p>This revision has not produced an assessment. A synthetic amplifier run reports its validation instead.</p></body></html>`;
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
  const gapsOf = (r: ReturnType<typeof drsReport>) => r.assessment?.requirementGaps ?? [];
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
    status: r.assessment?.status ?? 'NO_VERDICT',
    score: r.assessment?.score ?? null,
    terminalLevel: r.assessment?.terminalLevel ?? null,
    terminalOutcome: r.assessment?.terminalOutcome ?? 'no assessment',
    proofs: r.proofs.length,
  });
  return {
    a: side(a),
    b: side(b),
    deltas: {
      statusChanged: (a.assessment?.status ?? null) !== (b.assessment?.status ?? null),
      levelChange: (b.assessment?.terminalLevel ?? 0) - (a.assessment?.terminalLevel ?? 0),
      proofDelta: b.proofs.length - a.proofs.length,
      gapsResolved: resolved,
      gapsRemaining: remaining,
      gapsRegressed: regressed,
    },
  };
}
