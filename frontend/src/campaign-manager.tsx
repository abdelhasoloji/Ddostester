import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Campaign, type DrsSequencePlan, type SuiteSequenceState } from './api.js';
import { useApp, canDo } from './context.js';
import { NewCampaignForm } from './new-campaign-form.js';
import { HelpTip } from './help-tip.js';
import { Modal } from './modal.js';
import './campaign-manager.css';
export function CampaignManager() {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const [template, setTemplate] = useState<Campaign>();
  const [stopping, setStopping] = useState(false);
  const [statusKnown, setStatusKnown] = useState(false);
  const [level, setLevel] = useState(5),
    [interval, setIntervalSec] = useState(30),
    [plan, setPlan] = useState<DrsSequencePlan>(),
    [error, setError] = useState(''),
    [configure, setConfigure] = useState(false),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [attested, setAttested] = useState(false),
    [seqs, setSeqs] = useState<Record<string, SuiteSequenceState>>({});
  const groups = [
    ...new Map(
      app.campaigns.filter((c) => c.drsSequence && c.suiteId).map((c) => [c.suiteId!, c]),
    ).values(),
  ];
  const selected = params.get('suite');
  const members = app.campaigns
    .filter((c) => c.suiteId === selected)
    .sort((a, b) => (a.suiteOrder ?? 0) - (b.suiteOrder ?? 0));
  const first = members[0],
    binding = first?.drsSequence;
  const canCreate = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  const canApprove = canDo(app.role, 'approve', app.authRequired, app.userMode, app.capabilities);
  const canExecute = canDo(app.role, 'execute', app.authRequired, app.userMode, app.capabilities);
  const canKill = canDo(app.role, 'kill', app.authRequired, app.userMode, app.capabilities);
  useEffect(() => {
    let live = true;
    setPlan(undefined);
    setError('');
    void (selected ? api.savedDrsSequencePlan(selected) : api.drsSequencePlan(level, interval))
      .then((p) => {
        if (live) setPlan(p);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [level, interval, selected, binding?.targetLevel, binding?.intervalSec]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.suiteSequences();
        if (live) {
          setSeqs(r.sequences ?? {});
          setStatusKnown(true);
          if (Object.keys(r.sequences ?? {}).length) app.refresh();
        }
      } catch {
        if (live) setStatusKnown(false);
      } finally {
        if (live) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [app.refresh]);
  const frozen =
    members.length > 0 &&
    members.every((c) => {
      const r = c.drsDocument?.revisions.find((r) => r.number === c.drsDocument?.currentRevision);
      return !!r?.planHash && !r.finalizedAt;
    });
  const active = selected ? seqs[selected] : undefined;
  async function action(name: 'freeze' | 'run' | 'pause' | 'resume' | 'cancel' | 'archive') {
    if (!selected || !binding || (name === 'cancel' ? stopping : busy || stopping)) return;
    if (name === 'cancel') setStopping(true);
    else setBusy(true);
    setError('');
    try {
      if (name === 'freeze') await api.freezeDrsSequence(selected, binding.planHash);
      if (name === 'run')
        await api.runSuite(selected, app.approvalPolicy === 'confirmation', binding.planHash);
      if (name === 'pause') await api.pauseSuite(selected);
      if (name === 'resume') await api.resumeSuite(selected);
      if (name === 'cancel') await api.cancelSuite(selected);
      if (name === 'archive') await api.archiveSuite(selected, true);
      await app.refresh();
      setSeqs((await api.suiteSequences()).sequences ?? {});
      setConfirm(false);
      setAttested(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (name === 'cancel') setStopping(false);
      else setBusy(false);
    }
  }
  return (
    <section className="campaign-manager" aria-label="Campaign manager">
      <div className="card">
        <h2>Campaign manager</h2>
        <div className="manager-controls">
          <label>
            Target DRS score{' '}
            <select
              disabled={configure || !!selected}
              value={binding?.targetLevel ?? level}
              onChange={(e) => setLevel(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((l) => (
                <option key={l} value={l}>
                  DRS {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Interval between scenarios (s){' '}
            <input
              disabled={configure || !!selected}
              type="number"
              min={0}
              max={3600}
              value={binding?.intervalSec ?? interval}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
            />
          </label>
          <HelpTip label="Scenario interval">
            The interval is a minimum quiet period after a scenario settles. Recovery and baseline
            checks can extend it. Pause holds the next scenario; cancel stops the sequence. A DRS
            objective is not an achieved score.
          </HelpTip>
        </div>
        {error && <p role="alert">{error}</p>}
        {selected && !first && (
          <p role="alert">
            Campaign unavailable.{' '}
            <button className="btn" onClick={() => setParams({ tab: 'manager' })}>
              New campaign
            </button>
          </p>
        )}
        {!statusKnown && <p role="status">Live sequence state unavailable; launch is disabled.</p>}
        {!plan && !error && <p role="status">Loading campaign chain…</p>}
        {plan && (
          <>
            <p>
              <b>{plan.rows.length} reference scenarios</b> · {plan.executable} executable ·{' '}
              {plan.blocked} awaiting generator
            </p>
            <p className="hint">
              Laboratory sequence · DRS coverage incomplete{' '}
              <HelpTip label="DRS coverage">
                The complete reference chain is shown. Only supported bounded HTTP scenarios can be
                scheduled. Missing vectors are not excluded or counted as passed. No aggregate score
                is invented from scenario scores.
              </HelpTip>
            </p>
            {first && (
              <p className="hint">
                Executable sequence ≥{' '}
                {Math.ceil(
                  (members.length * (300 + first.maxDurationSec) +
                    Math.max(0, members.length - 1) * (binding?.intervalSec ?? 0)) /
                    60,
                )}{' '}
                min · recovery may extend this window
              </p>
            )}
            <details>
              <summary>Complete execution chain</summary>
              <ol className="campaign-chain">
                {plan.rows.map((r) => {
                  const c = members.find((c) => c.drsProfileId === r.id);
                  return (
                    <li key={r.id} className={c?.status === 'RUNNING' ? 'is-running' : ''}>
                      <span>
                        DRS {r.level} · {r.name}
                        {r.supported && (
                          <small>
                            {' '}
                            · baseline ≥300s → exposure {first?.maxDurationSec ?? 20}s → interval{' '}
                            {plan.intervalSec}s before the next scenario
                          </small>
                        )}
                      </span>
                      <b>
                        {r.supported ? (c?.status ?? 'Ready to configure') : 'Generator required'}
                      </b>
                      {!r.supported && <HelpTip label={'Requirements ' + r.id}>{r.reason}</HelpTip>}
                    </li>
                  );
                })}
              </ol>
            </details>
            {!selected && !configure && canCreate && (
              <button className="btn btn-primary" onClick={() => setConfigure(true)}>
                Configure campaign
              </button>
            )}
            {selected && first && (
              <div className="btn-row">
                <button
                  className="btn"
                  onClick={() => {
                    setParams({ tab: 'manager' });
                    setConfigure(false);
                    setTemplate(undefined);
                  }}
                >
                  New campaign
                </button>
                {canCreate && first && (
                  <button
                    className="btn"
                    onClick={() => {
                      setTemplate(first);
                      setLevel(binding?.targetLevel ?? 5);
                      setIntervalSec(binding?.intervalSec ?? 30);
                      setParams({ tab: 'manager' });
                      setConfigure(false);
                    }}
                  >
                    Duplicate campaign
                  </button>
                )}
                {canApprove && !frozen && !active && (
                  <button
                    className="btn btn-primary"
                    disabled={
                      busy ||
                      members.some(
                        (c) => c.archived || !['PENDING_APPROVAL', 'APPROVED'].includes(c.status),
                      )
                    }
                    onClick={() => void action('freeze')}
                  >
                    Freeze campaign plans
                  </button>
                )}
                {canExecute && frozen && !active && (
                  <button
                    className="btn btn-primary"
                    disabled={busy || !statusKnown || members.some((c) => c.archived)}
                    onClick={() => {
                      setConfirm(true);
                      setAttested(false);
                    }}
                  >
                    Review and launch campaign
                  </button>
                )}
                {active && canKill && (
                  <>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => void action(active.paused ? 'resume' : 'pause')}
                    >
                      {active.paused ? 'Resume campaign' : 'Pause campaign'}
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={stopping}
                      onClick={() => void action('cancel')}
                    >
                      {stopping ? 'Stopping campaign…' : 'Stop campaign'}
                    </button>
                  </>
                )}
                <Link className="btn" to={'/theater?suite=' + encodeURIComponent(selected)}>
                  Open Run Theater
                </Link>
                <a
                  className="btn"
                  href={'/api/suites/' + encodeURIComponent(selected) + '/drs/report?format=html'}
                  target="_blank"
                  rel="noreferrer"
                >
                  Campaign report
                </a>
                {canCreate && !active && (
                  <button className="btn" disabled={busy} onClick={() => void action('archive')}>
                    Archive campaign
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {configure && plan && !selected && (
        <NewCampaignForm
          initial={{
            name: `DRS ${level} campaign`,
            agent: 'fleet',
            drsProfileId: plan.rows.find((r) => r.supported)?.id,
            maxRps: 3,
            concurrency: 3,
            maxDurationSec: 20,
            target: template?.target ?? '',
            probeUrl: template?.probeUrl ?? '',
            fleetDeviceIds: template?.fleetDeviceIds ?? [],
          }}
          onCreate={async (payload) => {
            const r = await api.createDrsSequence({
              ...payload,
              targetLevel: level,
              intervalSec: interval,
              createdBy: app.identity?.email ?? app.operator,
            });
            await app.refresh();
            setParams({ tab: 'manager', suite: r.suiteId });
            return r.campaigns[0];
          }}
          onDone={() => setConfigure(false)}
        />
      )}
      {groups.length > 0 && (
        <div className="card">
          <h3>Campaigns</h3>
          <div className="manager-controls">
            {groups.map((c) => (
              <button
                className="btn"
                key={c.suiteId}
                onClick={() => {
                  setParams({ tab: 'manager', suite: c.suiteId! });
                  setConfigure(false);
                }}
              >
                {c.suiteName} · DRS {c.drsSequence?.targetLevel}
                {c.archived ? ' · archived' : ''}
              </button>
            ))}
          </div>
        </div>
      )}
      {selected && first && (
        <div className="card">
          <h3>{first.suiteName}</h3>
          <p>
            {first.target} · {first.fleetDeviceIds?.length ?? 0} agents · {first.maxRps} req/s
            shared
          </p>
          <ol>
            {members.map((c) => (
              <li key={c.id}>
                <Link to={'/campaigns?tab=evidence&campaign=' + encodeURIComponent(c.id)}>
                  {c.name}
                </Link>{' '}
                · {c.status}
                {c.statusDetail && <p role="status">{c.statusDetail}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {confirm && first && binding && (
        <Modal
          label="Confirm campaign sequence"
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <h3>Launch campaign · DRS {binding.targetLevel} objective</h3>
          <p>{first.target}</p>
          <p>
            {members.length} sequential scenarios · {binding.intervalSec}s minimum interval ·{' '}
            {first.maxRps} req/s shared per scenario
          </p>
          <label className="attest">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            I confirm the executable laboratory sequence. Missing DRS vectors remain unevaluated.
          </label>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !attested || !statusKnown}
              onClick={() => void action('run')}
            >
              Launch campaign
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
