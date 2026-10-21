import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Campaign, type DrsReportView, type DrsRevisionView } from './api.js';
import { LineIcon } from './interface-kit.js';
import { Chip, StateChip } from './design-system.js';

const STATE_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PLAN_FROZEN: 'Plan frozen',
  CAPACITY_CHECK: 'Capacity',
  BASELINE: 'Baseline',
  LEVEL_EXECUTION: 'Exposure',
  RECOVERY: 'Recovery',
  EVIDENCE_VALIDATION: 'Evidence',
  LEVEL_CALCULATION: 'Calculation',
  FINAL_REPORT: 'Verdict',
  ENGINE_VALIDATED: 'Engine validated',
};

/**
 * One assessment, two truths. A measured campaign shows its sealed evidence, the requirements
 * it reached and the ones it did not. A synthetic amplifier run shows what it validated and,
 * with the same weight, what it did not — no verdict is invented for it.
 */
export function AssessmentPage() {
  const { id = '' } = useParams();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [revision, setRevision] = useState<DrsRevisionView | null>(null);
  const [report, setReport] = useState<DrsReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compareWith, setCompareWith] = useState('');
  const [peers, setPeers] = useState<Campaign[]>([]);
  const [tab, setTab] = useState<'progress' | 'evidence' | 'requirements' | 'reports'>('progress');

  useEffect(() => {
    let cancelled = false;
    api
      .drsCampaign(id)
      .then(async (doc) => {
        if (cancelled) return;
        const rev =
          doc.document?.revisions.find((r) => r.number === doc.document?.currentRevision) ??
          doc.document?.revisions[0] ??
          null;
        setRevision(rev);
        const list = await api.listCampaigns();
        if (!cancelled) {
          setCampaign(list.find((c) => c.id === id) ?? null);
          setPeers(
            list.filter(
              (c) =>
                c.id !== id &&
                c.drsDocument?.revisions.some((r) => r.finalizedAt) &&
                c.drsDocument?.revisions.some(
                  (r) => (r.plan as { mode?: string }).mode === 'measured',
                ),
            ),
          );
        }
        try {
          const r = await api.drsCampaignReport(id);
          if (!cancelled) setReport(r);
        } catch {
          /* a plan that has not run has no report yet */
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the id only: the campaign list is read once per page, and
    // depending on a freshly-built array re-runs the effect on every render.
  }, [id]);

  if (error) return <p role="alert">{error}</p>;
  if (!revision) return <p className="hint">Loading assessment…</p>;

  const plan = (revision.plan ?? {}) as { mode?: string; maxLevel?: number; exposureSec?: number };
  const synthetic = report?.synthetic ?? null;
  const assessment = (report?.assessment ?? null) as DrsReportView['assessment'] | null;
  const measured = plan.mode === 'measured';
  const running =
    !revision.finalizedAt &&
    [
      'CAPACITY_CHECK',
      'BASELINE',
      'LEVEL_EXECUTION',
      'RECOVERY',
      'EVIDENCE_VALIDATION',
      'LEVEL_CALCULATION',
    ].includes(revision.state);

  const points = report?.proofs?.flatMap((p) => p.data?.points ?? []) ?? [];
  const transactions =
    report?.proofs?.flatMap((p) => p.data?.legitimate_transaction_success ?? []) ?? [];

  return (
    <>
      <div className="page-head page-head--icon">
        <div>
          <h1>
            {campaign?.name ?? 'Assessment'}{' '}
            <Chip tone={measured ? 'info' : 'plain'}>{measured ? 'measured' : 'synthetic'}</Chip>
            {revision.finalizedAt ? null : <StateChip state={revision.state} />}
          </h1>
          <p className="hint">
            {campaign?.target} · revision {revision.number} ·{' '}
            {revision.finalizedAt
              ? `finalized ${new Date(revision.finalizedAt).toLocaleString()}`
              : (STATE_LABELS[revision.state] ?? revision.state)}
          </p>
        </div>
        <span className="page-head-icon" aria-hidden="true">
          <LineIcon name="shield" />
        </span>
      </div>

      <div className="ui-tabs" role="tablist">
        {(
          [
            ['progress', 'Progress'],
            ['evidence', 'Evidence'],
            ['requirements', 'Requirements'],
            ['reports', 'Reports'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'on' : ''}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'progress' && (
        <>
          <ol className="wizard-steps" aria-label="State timeline">
            {revision.trace.map((t) => (
              <li key={`${t.state}-${t.at}`} className="done" title={t.detail}>
                {STATE_LABELS[t.state] ?? t.state}
              </li>
            ))}
            {running && <li className="on">running…</li>}
          </ol>
          <p className="hint">
            The trace is the campaign's own journal: every transition is sealed on the revision.
          </p>
          {assessment && (
            <section
              className="ui-card"
              style={{
                borderLeft: `4px solid ${assessment.status === 'COMPLETE' ? '#2e7d32' : '#b26a00'}`,
                marginTop: '1rem',
              }}
            >
              <h2 style={{ marginTop: 0 }}>
                {assessment.status} · terminal level {assessment.terminalLevel ?? '—'} ·{' '}
                {assessment.terminalOutcome}
              </h2>
              <p className="hint" style={{ marginBottom: 0 }}>
                {assessment.score === null ? 'No usable score. ' : `Score ${assessment.score}. `}
                Never a certification: the assessment states the requirements the fleet did not
                reach.
              </p>
            </section>
          )}
          {synthetic && (
            <section
              className="ui-card"
              style={{ borderLeft: '4px solid #a35a00', marginTop: '1rem' }}
            >
              <h2 style={{ marginTop: 0 }}>Synthetic amplifier · non-certifying</h2>
              <p className="hint" style={{ marginBottom: 0 }}>
                This run validated the instrument, not the target: no traffic reached the client
                target, no level is qualified and no verdict is produced.
              </p>
            </section>
          )}
        </>
      )}

      {tab === 'evidence' && (
        <>
          {synthetic && (
            <>
              <section className="card" style={{ borderLeft: '4px solid #b26a00' }}>
                <h2 style={{ marginTop: 0 }}>Synthetic amplifier · non-certifying</h2>
                <p className="hint" style={{ marginBottom: 0 }}>
                  This run validated the instrument, not the target. No traffic reached the client
                  target, no level is qualified and no verdict is produced.
                </p>
              </section>

              <div className="grid2">
                <section className="card">
                  <h2 style={{ marginTop: 0 }}>Claimed versus produced</h2>
                  <table className="campaign-table">
                    <thead>
                      <tr>
                        <th />
                        <th>Claimed</th>
                        <th>Produced</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Rate</td>
                        <td>{synthetic.claimed.rps} rps</td>
                        <td>{synthetic.produced.rps} rps</td>
                      </tr>
                      <tr>
                        <td>Concurrency</td>
                        <td>{synthetic.claimed.concurrency}</td>
                        <td>{synthetic.produced.concurrency}</td>
                      </tr>
                      <tr>
                        <td>Duration</td>
                        <td>{synthetic.claimed.durationSec}s</td>
                        <td>{synthetic.produced.durationSec}s</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="hint">
                    Fidelity <b>{(synthetic.fidelity * 100).toFixed(1)} %</b> · sealed{' '}
                    {new Date(synthetic.sealedAt).toLocaleString()} ·{' '}
                    <span className="mono">{synthetic.hash.slice(0, 16)}…</span>
                  </p>
                </section>
                <section className="card">
                  <h2 style={{ marginTop: 0 }}>Controls</h2>
                  <table className="campaign-table">
                    <tbody>
                      {synthetic.controls.map((c) => (
                        <tr key={c.id}>
                          <td>{c.id}</td>
                          <td>
                            {c.ok ? (
                              <span className="ok">ok</span>
                            ) : (
                              <span className="no">not ok</span>
                            )}
                          </td>
                          <td className="hint">{c.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              </div>
            </>
          )}

          {!synthetic && assessment && (
            <>
              <h2>Observation points</h2>
              {points.length === 0 ? (
                <p className="hint">No sealed proof yet.</p>
              ) : (
                <table className="campaign-table">
                  <thead>
                    <tr>
                      <th>Point</th>
                      <th>Observed load</th>
                      <th>Samples</th>
                      <th>Artifact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p) => (
                      <tr key={`${p.sourceId}-${p.artifactHash ?? ''}`}>
                        <td>
                          <b>{p.sourceId}</b>
                        </td>
                        <td>{p.load ? `${p.load.value} ${p.load.unit}` : '—'}</td>
                        <td>{p.sampleCount ?? '—'}</td>
                        <td className="mono">{p.artifactHash?.slice(0, 16) ?? '—'}…</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {transactions.length > 0 && (
                <p className="hint">
                  Legitimate transactions:{' '}
                  {transactions.map((t) => `${t.successful}/${t.total}`).join(' · ')}
                </p>
              )}
            </>
          )}
        </>
      )}

      {tab === 'requirements' && (
        <>
          {assessment && (
            <>
              <table className="campaign-table">
                <thead>
                  <tr>
                    <th>Vector</th>
                    <th>Dimension</th>
                    <th>Required</th>
                    <th>Recorded</th>
                    <th>Reached</th>
                  </tr>
                </thead>
                <tbody>
                  {(assessment.requirementGaps ?? []).map((g) => (
                    <tr key={`${g.vectorId}-${g.dimension}`} className={g.met ? '' : 'unmet'}>
                      <td>{g.vectorId}</td>
                      <td>{g.dimension}</td>
                      <td>{g.required}</td>
                      <td>{g.achieved}</td>
                      <td>
                        {g.met ? <span className="ok">yes</span> : <span className="no">no</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!assessment && (
            <p className="hint">No assessment yet: the campaign has not produced a verdict.</p>
          )}
        </>
      )}

      {tab === 'reports' && (
        <>
          <p className="hint">
            The client deliverable is the report; the bundle adds the manifest and the hashes.
          </p>
          <h2>Compare</h2>
          <p className="row">
            <select
              aria-label="Compare with"
              value={compareWith}
              onChange={(e) => setCompareWith(e.target.value)}
            >
              <option value="">— another finalized assessment —</option>
              {peers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <a
              className={`btn btn-sm${compareWith ? ' btn-primary' : ''}`}
              href={
                compareWith
                  ? `/assessments/${encodeURIComponent(id)}/compare/${encodeURIComponent(compareWith)}`
                  : '#'
              }
              aria-disabled={!compareWith}
            >
              Compare
            </a>
          </p>

          <h2>Deliverables</h2>
          <p className="row">
            <a
              className="btn btn-sm"
              href={`/api/campaigns/${encodeURIComponent(id)}/drs/report.html`}
              target="_blank"
              rel="noreferrer"
            >
              Report HTML
            </a>
            <a
              className="btn btn-sm"
              href={`/api/campaigns/${encodeURIComponent(id)}/drs/report.json`}
              target="_blank"
              rel="noreferrer"
            >
              Report JSON
            </a>
            <a className="btn btn-sm" href={`/api/campaigns/${encodeURIComponent(id)}/drs/bundle`}>
              Evidence bundle (zip)
            </a>
            <a className="btn btn-sm" href="/drs">
              Back to campaigns
            </a>
          </p>
        </>
      )}
    </>
  );
}
