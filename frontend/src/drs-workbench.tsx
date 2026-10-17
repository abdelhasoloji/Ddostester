import { HelpTip } from './help-tip.js';
import { ClientPrototype } from './client-prototype.js';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from './api.js';
import { useApp, canDo } from './context.js';
import { PageHead } from './pages.js';
import type { ClientWorkspaceList, ClientProfile } from './client-workspace-types.js';
import type { InfrastructureWorkspace } from './infrastructure-types.js';
import { InfrastructureWorkspacePanel } from './infrastructure-workspace.js';
import './drs-workbench.css';

function useClients() {
  const [data, setData] = useState<ClientWorkspaceList>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .clientWorkspaces()
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  async function reload() {
    setBusy(true);
    setError('');
    try {
      setData(await api.clientWorkspaces());
    } catch (e) {
      setData(undefined);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { data, setData, error, setError, busy, setBusy, reload };
}
function ClientCards({ data }: { data: ClientWorkspaceList }) {
  return (
    <div className="workbench-clients">
      {data.clients.map((c) => (
        <Link className="workbench-client" key={c.id} to={'/clients/' + encodeURIComponent(c.id)}>
          <span className="workbench-eyebrow">
            {c.profile.environment === 'preproduction'
              ? 'Preproduction'
              : c.profile.environment === 'lab'
                ? 'Laboratory'
                : 'Environment to confirm'}
          </span>
          <h3>{c.profile.name}</h3>
          <p>{c.profile.reference || 'Address to be confirmed'}</p>
          <span className="workbench-tag">Authorized client</span>
          <dl>
            <div>
              <dt>Assessment goal</dt>
              <dd>DRS 5</dd>
            </div>
            <div>
              <dt>Measured result</dt>
              <dd>Not evaluated</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{c.profile.scope ? 'Draft recorded' : 'To define'}</dd>
            </div>
          </dl>
          <span className="workbench-open">Open workspace →</span>
        </Link>
      ))}
    </div>
  );
}
export function DrsWorkbenchHome({ clientsOnly = false }: { clientsOnly?: boolean }) {
  const state = useClients();
  return (
    <div className="drs-workbench">
      <PageHead
        title={clientsOnly ? 'Clients' : 'WEDOS campaigns'}
        sub={clientsOnly ? 'Three authorized clients' : 'Prepare · execute · review'}
      />
      {!clientsOnly && (
        <>
          <section className="workbench-hero" aria-label="WEDOS campaigns">
            <div>
              <span className="workbench-eyebrow">WEDOS · internal assessment</span>
              <h2>Prepare your DRS campaign</h2>
              <p>
                Target → prepare → confirm → follow → report{' '}
                <HelpTip label="Campaign workflow">
                  Choose an authorized target and an executable Fleet profile, review the bounded
                  plan, then explicitly confirm execution. Preflight and baseline checks still
                  apply. DRS 5 is the objective; current HTTP laboratory campaigns do not establish
                  that level.
                </HelpTip>
              </p>
              <Link className="btn btn-primary" to="/campaigns?tab=manager">
                Prepare campaign
              </Link>
            </div>
            <div className="workbench-pilot">
              <Link to="/campaigns?tab=launch">Resume a campaign →</Link>
              <Link to="/theater">Follow running campaign →</Link>
              <Link to="/reports">View reports →</Link>
            </div>
          </section>
          <details className="card">
            <summary>Infrastructure preparation · DRS 5 objective</summary>
            <p>2 PoPs · 1 independent probe · qualification pending</p>
            <Link to="/infrastructure">Review infrastructure →</Link>
          </details>
        </>
      )}
      <section aria-label="Client workspaces">
        <div className="workbench-heading">
          <h2>{clientsOnly ? 'Client portfolio' : 'Client workspaces'}</h2>
          <button
            className="btn btn-sm btn-ghost"
            disabled={state.busy}
            onClick={() => void state.reload()}
          >
            Refresh clients
          </button>
        </div>

        {state.error ? (
          <p role="alert">Client workspaces unavailable: {state.error}</p>
        ) : state.data ? (
          <ClientCards data={state.data} />
        ) : (
          <p role="status">Loading client workspaces…</p>
        )}
      </section>
    </div>
  );
}
export function ClientWorkspacePage() {
  const { id } = useParams(),
    app = useApp(),
    state = useClients();
  const client = state.data?.clients.find((c) => c.id === id);
  const [draft, setDraft] = useState<ClientProfile>(),
    [message, setMessage] = useState(''),
    [history, setHistory] = useState('');
  const editable = canDo(app.role, 'manage', app.authRequired, app.userMode, app.capabilities);
  async function save() {
    if (!client || !draft || state.busy) return;
    state.setBusy(true);
    state.setError('');
    setMessage('');
    try {
      const saved = await api.saveClientWorkspace(client.id, client.revision, draft);
      state.setData({
        ...state.data!,
        clients: state.data!.clients.map((c) => (c.id === saved.id ? saved : c)),
      });
      setDraft(undefined);
      setMessage('Client scope saved.');
    } catch (e) {
      state.setError((e as Error).message);
    } finally {
      state.setBusy(false);
    }
  }
  return (
    <div className="drs-workbench">
      <Link className="workbench-back" to="/clients">
        ← All clients
      </Link>
      <PageHead
        title={client?.profile.name ?? 'Client workspace'}
        sub="Assessment workspace · DRS 5"
      />
      {state.error && <p role="alert">{state.error}</p>}
      {message && <p role="status">{message}</p>}
      {!client && !state.error ? (
        <p>{state.data ? 'Unknown client. Choose an existing workspace.' : 'Loading client…'}</p>
      ) : (
        client && (
          <>
            <div className="workbench-client-summary">
              <span className="workbench-tag">Authorized client</span>
              <span>
                Goal <b>DRS 5</b>
              </span>
              <span>
                Measured result <b>Not evaluated</b>
              </span>
            </div>
            <section className="card">
              <div className="workbench-heading">
                <h2>Client perimeter</h2>
                {editable && !draft && (
                  <button
                    className="btn btn-primary"
                    onClick={() => setDraft({ ...client.profile })}
                  >
                    Edit client scope
                  </button>
                )}
              </div>
              <p className="hint">
                Authorized client{' '}
                <HelpTip label="Client scope">
                  Client identity is fixed. The client record does not grant permission to execute
                  traffic against a specific URL.
                </HelpTip>
              </p>
              {draft ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  <div className="workbench-form">
                    {(['name', 'reference', 'owner', 'scope', 'notes'] as const).map((key) => (
                      <label key={key}>
                        {
                          {
                            name: 'Client name',
                            reference: 'Domain or address reference',
                            owner: 'Assessment owner',
                            scope: 'Services and functional scope',
                            notes: 'Preparation notes',
                          }[key]
                        }
                        {key === 'scope' || key === 'notes' ? (
                          <textarea
                            maxLength={2000}
                            value={draft[key]}
                            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                          />
                        ) : (
                          <input
                            required={key === 'name'}
                            readOnly={key === 'name'}
                            maxLength={key === 'name' ? 100 : 256}
                            value={draft[key]}
                            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                  <button className="btn btn-primary" disabled={state.busy} type="submit">
                    Save client scope
                  </button>{' '}
                  <button
                    className="btn btn-ghost"
                    disabled={state.busy}
                    type="button"
                    onClick={() => setDraft(undefined)}
                  >
                    Cancel edit
                  </button>
                </form>
              ) : (
                <dl className="workbench-scope">
                  <div>
                    <dt>Reference</dt>
                    <dd>{client.profile.reference || 'To confirm'}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{client.profile.owner || 'To assign'}</dd>
                  </div>
                  <div>
                    <dt>Functional scope</dt>
                    <dd>{client.profile.scope || 'To define'}</dd>
                  </div>
                  <div>
                    <dt>Notes</dt>
                    <dd>{client.profile.notes || 'No notes yet'}</dd>
                  </div>
                </dl>
              )}
            </section>
            <ClientPrototype key={client.id} client={client} />
            <div className="workbench-two-col">
              <section className="card">
                <h2>Infrastructure</h2>
                <p>
                  2 PoPs + independent probe{' '}
                  <HelpTip label="Client infrastructure">
                    Shared pilot hypothesis. Client placement, collection and measured capacity
                    remain to qualify.
                  </HelpTip>
                </p>
                <Link className="btn btn-secondary" to="/infrastructure">
                  Review pilot prerequisites
                </Link>
              </section>
              <section className="card">
                <h2>Evidence and report</h2>
                <p>
                  Measured assessment pending{' '}
                  <HelpTip label="Measured evidence">
                    Prototype reports contain virtual events and do not establish a measured client
                    resilience level.
                  </HelpTip>
                </p>
                <span className="workbench-tag">Not evaluated</span>
              </section>
            </div>
            <details className="card">
              <summary>Scope revisions</summary>
              <p>
                Revision {client.revision}
                {client.revision === 0
                  ? ' · initial authorized client record'
                  : ' · persisted client record'}
              </p>
              {client.hash && (
                <p className="hint">
                  SHA-256: <code>{client.hash}</code>
                </p>
              )}
              <button
                className="btn btn-sm"
                disabled={state.busy}
                onClick={async () => {
                  state.setBusy(true);
                  try {
                    setHistory(
                      JSON.stringify(await api.clientWorkspaceHistory(client.id), null, 2),
                    );
                  } catch (e) {
                    state.setError((e as Error).message);
                  } finally {
                    state.setBusy(false);
                  }
                }}
              >
                Load scope history
              </button>
              {history && <pre>{history}</pre>}
            </details>
          </>
        )
      )}
    </div>
  );
}
export function PilotInfrastructurePage() {
  const app = useApp(),
    [data, setData] = useState<InfrastructureWorkspace>(),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api
      .infrastructure()
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  const p = data?.passivePrototype;
  return (
    <div className="drs-workbench">
      <PageHead
        title="Pilot infrastructure"
        sub="2 PoPs + independent probe · qualification pending"
      />
      {error && (
        <p role="alert">
          Infrastructure observation unavailable: {error}. Current deployment state is unknown.
        </p>
      )}
      <div className="workbench-sites">
        <section className="card">
          <span className="workbench-eyebrow">PoP 01</span>
          <h2>{p?.host.name ?? 'First site'}</h2>
          <span className="workbench-tag">
            {p ? 'Dated SSH observation' : 'Awaiting observation'}
          </span>
          <p>
            {p
              ? `${p.host.architecture} · ${p.host.virtualization} · recorded ${p.observedOn}`
              : 'No verified host data loaded.'}
          </p>
          <p>
            Kubernetes deployment: <b>Not verified</b>
          </p>
          <p>
            Three passive telemetry Pods are planned. Observed Ready Pods:{' '}
            <b>{p?.observedReadyPods ?? 'Unknown'}</b>.
          </p>
        </section>
        <section className="card">
          <span className="workbench-eyebrow">PoP 02</span>
          <h2>Site to assign</h2>
          <span className="workbench-tag">Pending infrastructure</span>
          <p>
            Location and network path pending{' '}
            <HelpTip label="Second site">
              An independent site, assigned server, source addresses and measured capacity are
              required.
            </HelpTip>
          </p>
        </section>
        <section className="card">
          <span className="workbench-eyebrow">Independent measurement</span>
          <h2>External probe</h2>
          <span className="workbench-tag">To provision</span>
          <p>
            Independent observation{' '}
            <HelpTip label="Probe prerequisites">
              Separate resources and path, qualified clock, functional reference and continuous
              collection.
            </HelpTip>
          </p>
        </section>
      </div>
      <section className="workbench-next">
        <div>
          <h2>Next handoff to infrastructure</h2>
          <p>
            Kubernetes access and reserved resources{' '}
            <HelpTip label="Infrastructure handoff">
              Provide the context, namespace and ac02 node label. Confirm resources, the second site
              and independent probe.
            </HelpTip>
          </p>
        </div>
      </section>
      <details className="workbench-technical">
        <summary>Technical inventory and evidence register</summary>
        <InfrastructureWorkspacePanel
          editable={canDo(app.role, 'manage', app.authRequired, app.userMode, app.capabilities)}
        />
      </details>
    </div>
  );
}
