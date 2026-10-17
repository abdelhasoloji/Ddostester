import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type SyntheticView, type DrsSequencePlan, type BenchCatalogue } from './api.js';
import { useApp, canDo } from './context.js';
import { Modal } from './modal.js';
import { HelpTip } from './help-tip.js';
import './campaign-manager.css';
const active = (state: string) => ['RUNNING', 'PAUSED', 'STOPPING'].includes(state);
export function SyntheticWorkspace() {
  const app = useApp(),
    [params, setParams] = useSearchParams();
  const id = params.get('synthetic');
  const [name, setName] = useState('DRS synthetic campaign'),
    [level, setLevel] = useState(Number(params.get('level') ?? 5)),
    [interval, setIntervalSec] = useState(2),
    [labTarget, setLabTarget] = useState(''),
    [authorized, setAuthorized] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [catalog, setCatalog] = useState<BenchCatalogue>(),
    [plan, setPlan] = useState<DrsSequencePlan>();
  const canCreate =
    canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities) &&
    canDo(app.role, 'bench', app.authRequired, app.userMode, app.capabilities);
  useEffect(() => {
    if (!canCreate) return;
    let live = true;
    void api
      .benchScenarios()
      .then((c) => {
        if (live) {
          setCatalog(c);
          setLabTarget(c.labTargets[0] ?? '');
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [canCreate]);
  useEffect(() => {
    let live = true;
    void api
      .drsSequencePlan(level, interval)
      .then((p) => {
        if (live) {
          setPlan(p);
          setError('');
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [level, interval]);
  const measuredSteps = plan?.rows.filter((r) => r.laboratory).length ?? 0;
  async function create() {
    setBusy(true);
    setError('');
    try {
      const c = await api.createSyntheticCampaign({
        name,
        targetLevel: level,
        intervalSec: interval,
        labTarget,
        authorized,
      });
      await app.refresh();
      setParams({ tab: 'manager', source: 'synthetic', synthetic: c.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Synthetic campaign manager">
      {id ? (
        <>
          <button
            className="btn"
            onClick={() => setParams({ tab: 'manager', source: 'synthetic' })}
          >
            New synthetic campaign
          </button>
          <SyntheticTheater id={id} />
        </>
      ) : canCreate ? (
        <div className="card">
          <h2>Synthetic campaign</h2>
          <div className="manager-controls">
            <label>
              Campaign name
              <input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Target DRS score
              <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((l) => (
                  <option key={l} value={l}>
                    DRS {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Interval between scenarios (s)
              <input
                type="number"
                min={0}
                max={3600}
                value={interval}
                onChange={(e) => setIntervalSec(Number(e.target.value))}
              />
            </label>
            <label>
              Isolated lab target
              <select value={labTarget} onChange={(e) => setLabTarget(e.target.value)}>
                {catalog?.labTargets.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
          </div>
          <p>
            {plan?.rows.length ?? '—'} scenarios · {measuredSteps} lab measurements ·{' '}
            {(plan?.rows.length ?? 0) - measuredSteps} simulations{' '}
            <HelpTip label="Synthetic coverage">
              Each reference row has a separate result. Registered shapes use unchanged isolated
              runner budgets; other rows replay their reference lifecycle without traffic. Neither
              establishes full measured DRS qualification.
            </HelpTip>
          </p>
          <details>
            <summary>Execution chain</summary>
            <ol>
              {plan?.rows.map((r) => (
                <li key={r.id}>
                  DRS {r.level} · {r.sourceVectorId} · {r.name} —{' '}
                  {r.laboratory ? 'Lab measurement (partial shape)' : 'Simulation · no traffic'}
                </li>
              ))}
            </ol>
          </details>
          <label>
            <input
              type="checkbox"
              checked={authorized}
              onChange={(e) => setAuthorized(e.target.checked)}
            />{' '}
            I authorize the bounded scenarios on this isolated lab target.
          </label>
          {!catalog?.dispatchEnabled && <p role="status">Synthetic runner dispatch unavailable.</p>}
          <button
            className="btn btn-primary"
            disabled={!authorized || !labTarget || !catalog?.dispatchEnabled || !plan || busy}
            onClick={() => void create()}
          >
            {busy ? 'Saving…' : 'Create synthetic campaign'}
          </button>
        </div>
      ) : (
        <p>Read-only campaign history.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Saved synthetic campaigns</summary>
        {app.campaigns
          .filter((c) => c.syntheticJourney)
          .map((c) => (
            <p key={c.id}>
              <Link to={'/campaigns?tab=manager&source=synthetic&synthetic=' + c.id}>{c.name}</Link>{' '}
              · {c.syntheticJourney?.state}
            </p>
          ))}
      </details>
    </section>
  );
}
export function SyntheticTheater({ id }: { id: string }) {
  const app = useApp();
  const [data, setData] = useState<SyntheticView>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [stopping, setStopping] = useState(false),
    [confirm, setConfirm] = useState(false),
    [attested, setAttested] = useState(false),
    [now, setNow] = useState(Date.now()),
    [filter, setFilter] = useState('ALL');
  const bench = canDo(app.role, 'bench', app.authRequired, app.userMode, app.capabilities),
    canExecute =
      bench &&
      canDo(app.role, 'execute', app.authRequired, app.userMode, app.capabilities) &&
      canDo(app.role, 'approve', app.authRequired, app.userMode, app.capabilities),
    canStop = canDo(app.role, 'kill', app.authRequired, app.userMode, app.capabilities);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    setData(undefined);
    setError('');
    const poll = async () => {
      try {
        const r = await api.syntheticCampaign(id);
        if (live) {
          setData(r);
          setError('');
          setNow(Date.now());
          settled =
            !active(r.campaign.syntheticJourney!.state) &&
            r.campaign.syntheticJourney!.state !== 'DRAFT';
          if (settled) void app.refresh();
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live && !settled) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id]);
  async function control(action: 'start' | 'pause' | 'resume' | 'stop') {
    if (action === 'stop') setStopping(true);
    else setBusy(true);
    try {
      await api.syntheticControl(
        id,
        action,
        action === 'start'
          ? { confirmed: true, planHash: data!.campaign.syntheticJourney!.planHash }
          : undefined,
      );
      setData(await api.syntheticCampaign(id));
      setError('');
      setConfirm(false);
      setAttested(false);
      void app.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (action === 'stop') setStopping(false);
      else setBusy(false);
    }
  }
  if (!data)
    return <p role={error ? 'alert' : 'status'}>{error || 'Loading synthetic campaign…'}</p>;
  const c = data.campaign,
    j = c.syntheticJourney!;
  const done = j.steps.filter((s, i) =>
    s.result
      ? s.result.kind !== 'NOT_EVALUATED' || !!s.result.runId
      : ['COMPLETED', 'FAILED'].includes(data.runs[i]?.status ?? ''),
  ).length;
  const measured = j.steps.filter((s) => s.result?.kind === 'LAB_MEASUREMENT').length,
    simulated = j.steps.filter((s) => s.result?.kind === 'SIMULATION').length,
    unevaluated = j.steps.filter((s) => s.result?.kind === 'NOT_EVALUATED').length;
  const isActive = active(j.state),
    needsApproval = app.authRequired && app.userMode !== 'single' && c.status !== 'APPROVED';
  const report = c.drsDocument?.revisions.find(
    (r) => r.number === c.drsDocument?.currentRevision,
  )?.finalizedAt;
  return (
    <section className="card" aria-label="Synthetic Run Theater">
      <h2>{c.name}</h2>
      <p>
        <b>{j.state}</b> · objective DRS {j.definition.reference.targetLevel} · {done}/
        {j.steps.length} scenarios settled{' '}
        <HelpTip label="Observation meaning">
          Simulation emits no traffic and measures no service behavior. Lab measurement describes
          only the registered partial shape. Neither result PASSes an official DRS vector. Stop
          prevents subsequent scenarios; a claimed scenario finishes within its existing bound or
          becomes indeterminate on timeout.
        </HelpTip>
      </p>
      {j.definition.entries && (
        <p aria-label="Synthetic result counts">
          {measured} measured · {simulated} simulated · {unevaluated} not evaluated
        </p>
      )}
      <progress aria-label="Synthetic sequence progress" value={done} max={j.steps.length} />
      <p>
        {j.definition.labTarget} · interval {j.definition.reference.intervalSec}s
      </p>
      {j.nextAt && j.state === 'RUNNING' && j.nextAt > now && (
        <p role="status">Next scenario in {Math.max(0, Math.ceil((j.nextAt - now) / 1000))}s</p>
      )}
      {j.state === 'STOPPING' && (
        <p role="status">
          No next scenario will launch. Waiting for the current bounded scenario to settle.
        </p>
      )}
      {error && <p role="alert">Live state unavailable: {error}</p>}
      {j.definition.entries && (
        <label>
          Show scenarios{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="ALL">All scenarios</option>
            <option value="LAB_MEASUREMENT">Lab measurements</option>
            <option value="SIMULATION">Simulations</option>
          </select>
        </label>
      )}
      <ol className="campaign-chain" aria-label="Scenario results">
        {j.steps.map((s, i) => {
          const r = data.runs[i];
          if (filter !== 'ALL' && s.execution !== filter) return null;
          const simulation = s.execution === 'SIMULATION';
          return (
            <li
              key={s.vectorId ?? s.scenarioId}
              className={r?.status === 'CLAIMED' ? 'is-running' : ''}
            >
              <span>
                <b>{s.name ?? s.scenarioId}</b>
                {s.vectorId && (
                  <small>
                    {' '}
                    · DRS {s.level} · {s.vectorId.replace('drs-3.00.00-', '')}
                  </small>
                )}
                <br />
                {s.execution && (
                  <strong>
                    {simulation ? 'SIMULATION · NO TRAFFIC' : 'LAB MEASUREMENT · PARTIAL SHAPE'}{' '}
                    ·{' '}
                  </strong>
                )}
                {s.result?.outcome ?? r?.status ?? 'NOT_STARTED'}
                {r?.error && ' · ' + r.error}
                <HelpTip label={'Scenario details ' + (s.vectorId ?? s.scenarioId)}>
                  {s.result?.reason ??
                    (simulation
                      ? 'Reference lifecycle simulation, no traffic or measured service behavior.'
                      : 'Actual received counters for a bounded shape; full vector semantics, standard load and independent DRS evidence are not demonstrated.')}
                </HelpTip>
              </span>
              <span>
                {simulation
                  ? s.result?.kind === 'SIMULATION'
                    ? 'Simulated lifecycle complete'
                    : 'No measurement'
                  : r?.verdict?.connections
                    ? `${r.verdict.connections.accepted ?? '—'} connections accepted`
                    : r?.verdict?.target?.avgBps !== undefined
                      ? `${(r.verdict.target.avgBps / 1e6).toFixed(2)} Mbit/s received`
                      : s.result?.kind === 'NOT_EVALUATED'
                        ? 'Not measured'
                        : 'Awaiting runner observation'}
              </span>
            </li>
          );
        })}
      </ol>
      {j.reason && <p role="status">{j.reason}</p>}
      <div className="btn-row">
        {j.state === 'DRAFT' && canExecute && (
          <button
            className="btn btn-primary"
            disabled={busy || !!error || needsApproval}
            onClick={() => setConfirm(true)}
          >
            Review and launch synthetic campaign
          </button>
        )}
        {j.state === 'RUNNING' && bench && (
          <button className="btn" disabled={busy || !!error} onClick={() => void control('pause')}>
            Pause synthetic campaign
          </button>
        )}
        {j.state === 'PAUSED' && bench && (
          <button className="btn" disabled={busy || !!error} onClick={() => void control('resume')}>
            Resume synthetic campaign
          </button>
        )}
        {(isActive || j.state === 'DRAFT') && canStop && (
          <button
            className="btn btn-danger"
            disabled={stopping || j.state === 'STOPPING'}
            onClick={() => void control('stop')}
          >
            {stopping ? 'Stopping…' : 'Stop synthetic campaign'}
          </button>
        )}
        <Link className="btn" to={'/theater?synthetic=' + id}>
          Open Run Theater
        </Link>
        {report && (
          <>
            <a
              className="btn btn-primary"
              href={'/api/campaigns/' + id + '/drs/report.html'}
              target="_blank"
              rel="noreferrer"
            >
              Open final report
            </a>
            <a
              className="btn"
              href={'/api/campaigns/' + id + '/drs/report.json'}
              target="_blank"
              rel="noreferrer"
            >
              Download report JSON
            </a>
          </>
        )}
      </div>
      {needsApproval && j.state === 'DRAFT' && (
        <p role="status">Separate campaign approval required before launch.</p>
      )}
      {report && <p>Final report ready · partial laboratory evidence · no qualified DRS score.</p>}
      {confirm && (
        <Modal label="Confirm synthetic campaign" onClose={() => setConfirm(false)}>
          <h3>Review the bounded synthetic chain</h3>
          <p>
            {j.steps.length} reference scenarios · {j.definition.labTarget} · objective{' '}
            {j.definition.reference.targetLevel}
          </p>
          <label>
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />{' '}
            I confirm this frozen laboratory plan and its unchanged scenario bounds.
          </label>
          <div className="btn-row">
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!attested || busy}
              onClick={() => void control('start')}
            >
              Launch bounded synthetic campaign
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
