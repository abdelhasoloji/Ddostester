import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type DrsCampaignView, type DrsReportView } from './api.js';
import { useApp, canDo } from './context.js';
import type { ClientWorkspace } from './client-workspace-types.js';

export function ClientPrototype({ client }: { client: ClientWorkspace }) {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const selected = params.get('prototype') ?? '';
  const [view, setView] = useState<DrsCampaignView>();
  const [report, setReport] = useState<DrsReportView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fixture, setFixture] = useState('healthy');
  const [confirmed, setConfirmed] = useState(false);
  const canCreate = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  const canApprove = canDo(app.role, 'approve', app.authRequired, app.userMode, app.capabilities);
  const canExecute = canDo(app.role, 'execute', app.authRequired, app.userMode, app.capabilities);
  const campaigns = app.campaigns.filter((c) => c.clientWorkspace?.id === client.id && !c.archived);
  const revision = view?.document?.revisions.find(
    (r) => r.number === view.document?.currentRevision,
  );
  useEffect(() => {
    let live = true;
    setView(undefined);
    setReport(undefined);
    setError('');
    setConfirmed(false);
    if (selected) {
      void api
        .drsCampaign(selected)
        .then(async (next) => {
          if (
            next.clientWorkspace?.id !== client.id ||
            next.document?.revisions.some((r) => r.plan.mode !== 'engine-validation')
          )
            throw new Error('Select a prototype belonging to this client.');
          const r = next.document?.revisions.find(
            (r) => r.number === next.document?.currentRevision,
          );
          const result = r?.finalizedAt ? await api.drsReport(selected, r.number) : undefined;
          if (live) {
            setView(next);
            setReport(result);
          }
        })
        .catch((e: Error) => {
          if (live) setError(e.message);
        });
    }
    return () => {
      live = false;
    };
  }, [selected, client.id]);
  async function create() {
    setBusy(true);
    setError('');
    try {
      const c = await api.drsValidation(5, client.id);
      await app.refresh();
      const next = new URLSearchParams(params);
      next.set('prototype', c.id);
      setParams(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(name: 'freeze' | 'simulate' | 'finalize') {
    if (!selected || !revision || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.drsAction(selected, name, {
        revisionId: revision.id,
        ...(name === 'simulate' ? { fixture, confirmed } : {}),
      });
      const next = await api.drsCampaign(selected);
      setView(next);
      const r = next.document?.revisions.find((r) => r.number === next.document?.currentRevision);
      if (r?.finalizedAt) setReport(await api.drsReport(selected, r.number));
      setConfirmed(false);
      await app.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    if (!revision) return;
    setBusy(true);
    setError('');
    try {
      const full = await api.drsReport(selected, revision.number);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${client.id}-prototype-${selected}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card client-prototype" aria-label="Client prototype">
      <div className="workbench-heading">
        <div>
          <span className="workbench-tag">Simulation · no traffic</span>
          <h2>Test the complete assessment journey</h2>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy || !canCreate}
          onClick={() => void create()}
        >
          New prototype campaign
        </button>
      </div>
      <p>
        Create a client campaign, freeze its plan, follow Run Theater and download the report.
        Virtual events exercise the DRS engine through level 5; they do not measure this client's
        resilience.
      </p>
      <label>
        Saved prototype campaigns
        <select
          disabled={busy}
          value={selected}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('prototype', e.target.value);
            else next.delete('prototype');
            setParams(next);
          }}
        >
          <option value="">Choose a prototype</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.createdAt ? new Date(c.createdAt).toLocaleString() : 'Saved campaign'} ·{' '}
              {c.status}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {selected && !view && !error && <p role="status">Loading saved prototype…</p>}
      {revision && (
        <>
          <h3>1. Campaign plan</h3>
          <p>
            DRS {revision.reference.standardVersion} · maximum level{' '}
            {String(revision.plan.maxLevel)} · client scope revision{' '}
            {view?.clientWorkspace?.revision}. No physical target or agent is selected.
          </p>
          <p>
            Scope snapshot:{' '}
            {view?.clientWorkspace?.profile.scope || 'Not defined · simulation only'}
          </p>
          {!revision.planHash && (
            <button
              className="btn btn-primary"
              disabled={busy || !canApprove}
              onClick={() => void action('freeze')}
            >
              Freeze prototype plan
            </button>
          )}
          <h3>2. Run Theater · simulated events</h3>
          <p role="status">
            State: <b>{revision.state}</b> · {revision.proofs.length} archived proofs · physical
            agents: not used
          </p>
          <div className="prototype-stages" aria-label="Prototype execution timeline">
            <span>Plan {revision.planHash ? 'frozen' : 'draft'}</span>
            <span>Evidence {revision.proofs.length ? 'archived' : 'pending'}</span>
            <span>Report {revision.finalizedAt ? 'ready' : 'pending'}</span>
          </div>
          <details className="prototype-details">
            <summary>Execution journal · {revision.trace.length} events</summary>
            <ol>
              {revision.trace.map((t, i) => (
                <li key={i}>
                  <b>{t.state}</b> · {new Date(t.at).toLocaleTimeString()}
                  <p className="hint">{t.detail}</p>
                </li>
              ))}
            </ol>
          </details>
          {revision.planHash && !revision.finalizedAt && revision.proofs.length === 0 && (
            <>
              <label>
                Test case
                <select
                  value={fixture}
                  disabled={busy}
                  onChange={(e) => {
                    setFixture(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="healthy">Healthy service</option>
                  <option value="service-outage">Service outage</option>
                  <option value="generator-saturation">Generator saturation</option>
                  <option value="telemetry-gap">Missing telemetry</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I confirm this is a simulation, with no traffic and no measured DRS score.
              </label>
              <button
                className="btn btn-primary"
                disabled={busy || !confirmed || !canExecute}
                onClick={() => void action('simulate')}
              >
                Run simulated assessment
              </button>
            </>
          )}
          {revision.proofs.length > 0 && !revision.finalizedAt && (
            <button
              className="btn btn-primary"
              disabled={busy || !canApprove}
              onClick={() => void action('finalize')}
            >
              Generate final report
            </button>
          )}
          {report && (
            <section aria-label="Prototype report">
              <h3>3. Final report · simulation</h3>
              <p>
                <b>{report.assessment.label}</b> · {report.assessment.status}
              </p>
              <p>
                Simulation score: {report.assessment.score ?? 'Indeterminate'} · measured client
                score: not evaluated.
              </p>
              <table>
                <caption>Coverage by level</caption>
                <thead>
                  <tr>
                    <th>Level</th>
                    <th>Passed</th>
                    <th>Failed</th>
                    <th>Unknown</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {report.assessment.levels.map((l) => (
                    <tr key={l.level}>
                      <td>{l.level}</td>
                      <td>
                        {l.passed}/{l.total}
                      </td>
                      <td>{l.failed}</td>
                      <td>{l.inconclusive}</td>
                      <td>{l.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <details className="prototype-details">
                <summary>Report reservations · {report.assessment.reservations.length}</summary>
                <ul>
                  {report.assessment.reservations.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </details>
              <button className="btn btn-primary" disabled={busy} onClick={() => void download()}>
                Download prototype report
              </button>
              <p>
                The saved campaign and report remain available here after reloading.{' '}
                <Link to={'/campaigns?tab=evidence&campaign=' + encodeURIComponent(selected)}>
                  Open technical evidence
                </Link>
              </p>
            </section>
          )}
        </>
      )}
      {busy && <p role="status">Saving assessment state…</p>}
    </section>
  );
}
