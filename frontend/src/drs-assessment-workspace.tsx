import { Link } from 'react-router-dom';
import { HelpTip } from './help-tip.js';
import { DrsBaselineDiagnostic } from './drs-baseline-diagnostic.js';
import { useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useApp, canDo } from './context.js';
import { api, type DrsCampaignView, type DrsReferenceView, type DrsReportView } from './api.js';
export function DrsAssessmentWorkspace() {
  const app = useApp();
  const [params] = useSearchParams();
  const requested = params.get('campaign');
  const campaigns = app.campaigns.filter((c) => !c.archived);
  const [selected, setSelected] = useState(requested ?? '');
  useEffect(() => {
    if (requested) setSelected(requested);
  }, [requested]);
  const id = selected || campaigns[0]?.id;
  const campaign = campaigns.find((c) => c.id === id);
  const isFleet = campaign?.agent === 'fleet';
  const [reference, setReference] = useState<DrsReferenceView>();
  const [view, setView] = useState<DrsCampaignView>();
  const [report, setReport] = useState<DrsReportView>();
  const [plan, setPlan] = useState('');
  const [evidence, setEvidence] = useState('');
  const [fixture, setFixture] = useState('healthy');
  const [runId, setRunId] = useState('');
  const [benchRunId, setBenchRunId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const canCreate = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities),
    canApprove = canDo(app.role, 'approve', app.authRequired, app.userMode, app.capabilities),
    canExecute = canDo(app.role, 'execute', app.authRequired, app.userMode, app.capabilities);
  useEffect(() => {
    let live = true;
    api
      .drsReference()
      .then((r) => {
        if (live) setReference(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setView(undefined);
    setReport(undefined);
    setConfirmed(false);
    if (id)
      api
        .drsCampaign(id)
        .then((v) => {
          if (live) {
            setView(v);
            const r = v.document?.revisions.find((r) => r.number === v.document?.currentRevision);
            setPlan(JSON.stringify(r?.plan ?? v.defaultPlan, null, 2));
            if (r?.planHash)
              void api
                .drsReport(id, r.number)
                .then((report) => {
                  if (live) setReport(report);
                })
                .catch((e) => {
                  if (live) setError(e.message);
                });
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [id]);
  async function createValidation() {
    setBusy(true);
    setError('');
    try {
      const c = await api.drsValidation();
      await app.refresh();
      setSelected(c.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const revision = view?.document?.revisions.find(
    (r) => r.number === view.document?.currentRevision,
  );
  const planDirty = (() => {
    try {
      return !!revision && JSON.stringify(JSON.parse(plan)) !== JSON.stringify(revision.plan);
    } catch {
      return true;
    }
  })();
  async function action(name: string) {
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      const body =
        name === 'revisions'
          ? { plan: JSON.parse(plan) }
          : {
              revisionId: revision?.id,
              ...(name === 'simulate' ? { fixture, confirmed } : {}),
              ...(name === 'evidence' ? { evidence: JSON.parse(evidence) } : {}),
              ...(name === 'attachments'
                ? { runId: runId || undefined, benchRunId: benchRunId || undefined }
                : {}),
            };
      await api.drsAction(id, name, body);
      const next = await api.drsCampaign(id);
      setView(next);
      const r = next.document?.revisions.find((r) => r.number === next.document?.currentRevision);
      if (r?.planHash) setReport(await api.drsReport(id, r.number));
      await app.refresh();
      setConfirmed(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changeMode(mode: string) {
    try {
      setPlan(JSON.stringify({ ...JSON.parse(plan), mode }, null, 2));
    } catch {
      setError('Correct plan JSON before changing mode');
    }
  }
  function parameter(key: string, value: unknown) {
    try {
      setPlan(JSON.stringify({ ...JSON.parse(plan), [key]: value }, null, 2));
    } catch {
      setError('Correct plan JSON before editing parameters');
    }
  }
  function readParameter(key: string, fallback: number) {
    try {
      return Number(JSON.parse(plan)[key] ?? fallback);
    } catch {
      return fallback;
    }
  }
  async function download() {
    if (!id || !revision) return;
    setBusy(true);
    try {
      const full = await api.drsReport(id, revision.number);
      const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `drs-${id}-revision-${revision.number}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="drs-assessment-workspace" aria-label="DRS assessment workspace">
      <div className="card">
        <h2>{isFleet ? 'Campaign plan' : 'DRS assessment'}</h2>
        {!isFleet && (
          <>
            <p>
              Standard {reference?.manifest.version ?? '…'} ·{' '}
              {reference?.manifest.vector_count ?? '…'} reference vectors. WRS remains a separate
              diagnostic.
            </p>
            <p className="hint">
              A simulation validates this tool. A laboratory result describes the dimensions
              actually reproduced. Measured DRS requires independent evidence. No certification is
              issued.
            </p>
          </>
        )}
        <label>
          Campaign
          <select value={id ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {!isFleet && (
          <button
            className="btn btn-primary"
            disabled={busy || !canCreate}
            onClick={() => void createValidation()}
          >
            New engine validation · no traffic
          </button>
        )}
        {!id && (
          <p>
            Validate the engine without a target or Fleet enrollment, or create a bounded Fleet
            draft for laboratory observations.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      {view && (
        <div className="card">
          <h3>Review campaign plan</h3>
          {campaign?.agent === 'fleet' && (
            <p>
              <b>{campaign.target}</b> · {campaign.fleetDeviceIds?.length ?? 0} agents ·{' '}
              {campaign.maxRps} req/s shared · {campaign.maxDurationSec}s
            </p>
          )}
          <p className="hint">
            Prepare → freeze → confirm → baseline → execution → report{' '}
            <HelpTip label="Execution sequence">
              Freezing records the reviewed plan; it does not start traffic. The next confirmation
              starts server admission and at least five minutes of baseline observation. An unstable
              baseline stops the attempt before Fleet injection.
            </HelpTip>
          </p>
          <p>{revision ? `Revision ${revision.number} · ${revision.state}` : 'No plan yet'}</p>
          <details open={!isFleet}>
            <summary>
              Plan settings · baseline {readParameter('baselineMinSec', 300)}s · exposure{' '}
              {readParameter('exposureSec', 20)}s
            </summary>
            <label>
              Campaign mode
              <select
                disabled={busy || !canCreate}
                value={(() => {
                  try {
                    return JSON.parse(plan).mode ?? 'synthetic-lab';
                  } catch {
                    return 'synthetic-lab';
                  }
                })()}
                onChange={(e) => changeMode(e.target.value)}
              >
                <option value="engine-validation">Engine validation · simulated events</option>
                <option value="synthetic-lab">
                  Synthetic laboratory · experimental measurement
                </option>
                <option value="measured">
                  Measured evaluation · independent evidence required
                </option>
              </select>
            </label>
            <div className="row">
              <label>
                Maximum reference level
                <select
                  disabled={busy || !canCreate}
                  value={readParameter('maxLevel', 1)}
                  onChange={(e) => parameter('maxLevel', Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5, 6, 7].map((l) => (
                    <option key={l} value={l}>
                      Level {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Baseline seconds
                <input
                  type="number"
                  min={300}
                  max={600}
                  value={readParameter('baselineMinSec', 300)}
                  disabled={busy || !canCreate}
                  onChange={(e) => parameter('baselineMinSec', Number(e.target.value))}
                />
              </label>
              <label>
                Exposure seconds
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={readParameter('exposureSec', 20)}
                  disabled={busy || !canCreate}
                  onChange={(e) => parameter('exposureSec', Number(e.target.value))}
                />
              </label>
            </div>
            <p className="hint">
              Baseline: at least five minutes. Exposure must be justified within the existing
              budget. A plan change creates a new revision and keeps all historical evidence.
            </p>
            <details>
              <summary>Scope, architecture, instrumentation and verdict rules</summary>
              <label>
                Assessment plan JSON
                <textarea
                  aria-label="Assessment plan JSON"
                  value={plan}
                  rows={22}
                  onChange={(e) => setPlan(e.target.value)}
                  disabled={busy || !canCreate}
                />
              </label>
            </details>
          </details>
          {planDirty && (
            <p className="hint">
              Create a new revision to apply these edits before freezing or evaluating.
            </p>
          )}
          <div className="row">
            <button
              className="btn"
              disabled={busy || !canCreate}
              onClick={() => void action('revisions')}
            >
              {revision ? 'Create new revision' : 'Save campaign plan'}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !canApprove || revision?.state !== 'DRAFT' || planDirty}
              onClick={() => void action('freeze')}
            >
              Freeze plan
            </button>
            {!isFleet && (
              <button
                className="btn"
                disabled={busy || !canCreate || !revision?.planHash || !!revision.finalizedAt}
                onClick={() => void action('capacity')}
              >
                Check capacity
              </button>
            )}
          </div>
          {campaign?.agent === 'fleet' &&
            revision?.planHash &&
            !revision.finalizedAt &&
            revision.plan.mode === 'synthetic-lab' &&
            canExecute && (
              <button
                className="btn btn-primary"
                disabled={
                  busy ||
                  planDirty ||
                  !(
                    campaign.status === 'APPROVED' ||
                    (app.approvalPolicy === 'confirmation' &&
                      campaign.status === 'PENDING_APPROVAL')
                  )
                }
                onClick={() => app.setConfirmExec(campaign)}
              >
                Review and confirm campaign
              </button>
            )}
          {campaign?.status === 'RUNNING' && (
            <Link
              className="btn btn-primary"
              to={'/theater?run=' + encodeURIComponent(campaign.id)}
            >
              Follow campaign
            </Link>
          )}
          {revision?.planHash && (
            <details>
              <summary>Reference fingerprints</summary>
              <p className="hint" style={{ overflowWrap: 'anywhere' }}>
                Catalogue {revision.reference.catalogueHash} · plan {revision.planHash}
              </p>
            </details>
          )}
          {revision?.planHash &&
            revision.plan.mode === 'engine-validation' &&
            !revision.finalizedAt && (
              <div>
                <h3>Validate the engine without traffic</h3>
                <label>
                  Simulation fixture
                  <select value={fixture} onChange={(e) => setFixture(e.target.value)}>
                    <option value="healthy">Healthy services</option>
                    <option value="generator-saturation">Generator saturation</option>
                    <option value="service-outage">Functional service outage</option>
                    <option value="telemetry-gap">Independent telemetry gap</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />{' '}
                  I confirm this creates simulated events, with no resilience measurement.
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || !canExecute || !confirmed}
                  onClick={() => void action('simulate')}
                >
                  Run engine validation
                </button>
              </div>
            )}
          {revision?.planHash &&
            revision.plan.mode !== 'engine-validation' &&
            !revision.finalizedAt && (
              <details>
                <summary>Import independent collector evidence</summary>
                <label>
                  Existing campaign run ID
                  <input value={runId} onChange={(e) => setRunId(e.target.value)} />
                </label>
                <label>
                  Existing isolated lab verdict ID
                  <input value={benchRunId} onChange={(e) => setBenchRunId(e.target.value)} />
                </label>
                <button
                  className="btn"
                  disabled={busy || !canApprove || Boolean(runId) === Boolean(benchRunId)}
                  onClick={() => void action('attachments')}
                >
                  Attach existing observation
                </button>
                <p className="hint">
                  Attachments preserve measured counters and their limitations. They do not count as
                  successful standard vectors.
                </p>
                <p>
                  Collector artifact hashes, complete observation windows, functional transactions
                  and calibration are required. Missing data produces an indeterminate result. This
                  control imports evidence; it does not dispatch traffic.
                </p>
                <label>
                  Evidence JSON
                  <textarea
                    aria-label="Evidence JSON"
                    rows={12}
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                  />
                </label>
                <button
                  className="btn"
                  disabled={busy || !canApprove || !evidence}
                  onClick={() => void action('evidence')}
                >
                  Archive evidence
                </button>
              </details>
            )}
          {revision?.planHash && (
            <div className="row">
              <button
                className="btn"
                disabled={
                  busy ||
                  !canApprove ||
                  !!revision.finalizedAt ||
                  (isFleet &&
                    !['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL', 'CANCELLED'].includes(
                      campaign.status,
                    ))
                }
                onClick={() => void action('finalize')}
              >
                Finalize report
              </button>
              <button className="btn" disabled={busy} onClick={() => void download()}>
                Download reproducible JSON
              </button>
              <a
                className="btn"
                href={`/api/campaigns/${encodeURIComponent(id!)}/drs/report.html?revision=${revision.number}`}
                target="_blank"
                rel="noreferrer"
              >
                Open assessment report
              </a>
            </div>
          )}
          {revision && (
            <details>
              <summary>Workflow and archived attempts ({revision.proofs.length})</summary>
              <p>Archived revisions</p>
              <ul>
                {view.document?.revisions
                  .filter((r) => r.planHash)
                  .map((r) => (
                    <li key={r.id}>
                      <a
                        href={`/api/campaigns/${encodeURIComponent(id!)}/drs/report.html?revision=${r.number}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Revision {r.number} · {r.state}
                      </a>
                    </li>
                  ))}
              </ul>
              <ol>
                {revision.trace.map((t, i) => (
                  <li key={i}>
                    {t.state} · {t.detail}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
      {report && (!isFleet || !!revision?.finalizedAt) && (
        <div className="card" aria-label="DRS verdict">
          <h3>{report.assessment.label}</h3>
          <DrsBaselineDiagnostic diagnostic={report.baselineDiagnostic} />
          <p>
            <b>
              {report.assessment.status} · {report.assessment.score ?? 'No usable score'}
            </b>{' '}
            · terminal level {report.assessment.terminalLevel ?? '—'} /{' '}
            {report.assessment.terminalOutcome}
          </p>
          <div className="fleet-table-scroll">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Total</th>
                  <th>Passed</th>
                  <th>Failed</th>
                  <th>Unknown</th>
                  <th>Excluded</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {report.assessment.levels.map((l) => (
                  <tr key={l.level}>
                    <td>{l.level}</td>
                    <td>{l.total}</td>
                    <td>{l.passed}</td>
                    <td>{l.failed}</td>
                    <td>{l.inconclusive}</td>
                    <td>{l.excluded}</td>
                    <td>{l.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul>
            {report.assessment.reservations.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
