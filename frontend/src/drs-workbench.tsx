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
        title={clientsOnly ? 'Clients' : 'DRS workspace'}
        sub={
          clientsOnly
            ? 'The three authorized clients. Define and follow each perimeter separately.'
            : 'Prepare the clients, qualify the pilot, then collect evidence.'
        }
      />
      {!clientsOnly && (
        <>
          <section className="workbench-hero">
            <div>
              <span className="workbench-eyebrow">Assessment objective</span>
              <h2>
                DRS <strong>5</strong>
              </h2>
              <p>A measured resilience objective. No level has been established for this pilot.</p>
            </div>
            <div className="workbench-pilot">
              <b>2 PoPs</b>
              <span>pilot hypothesis</span>
              <b>1 independent probe</b>
              <span>outside the pilot node</span>
              <Link to="/infrastructure">Review infrastructure →</Link>
            </div>
          </section>
          <section className="workbench-process" aria-label="Assessment preparation stages">
            {[
              'Define scope',
              'Qualify infrastructure',
              'Validate measurements',
              'Evaluate',
              'Report',
            ].map((step, i) => (
              <div key={step}>
                <span>{i + 1}</span>
                <b>{step}</b>
                <small>{i < 3 ? 'Preparation' : 'Not started'}</small>
              </div>
            ))}
          </section>
        </>
      )}
      <section aria-label="Client workspaces">
        <div className="workbench-heading">
          <h2>{clientsOnly ? 'Client portfolio' : 'Start with a client'}</h2>
          <button
            className="btn btn-sm btn-ghost"
            disabled={state.busy}
            onClick={() => void state.reload()}
          >
            Refresh clients
          </button>
        </div>
        <p className="hint">
          The three authorized clients. Scope and evidence stay specific to each client.
        </p>
        {state.error ? (
          <p role="alert">Client workspaces unavailable: {state.error}</p>
        ) : state.data ? (
          <ClientCards data={state.data} />
        ) : (
          <p role="status">Loading client workspaces…</p>
        )}
      </section>
      {!clientsOnly && (
        <section className="workbench-next">
          <div>
            <span className="workbench-eyebrow">Next infrastructure milestone</span>
            <h2>Reserve the pilot and its independent probe</h2>
            <p>
              ac02 is the first observed host. The second PoP and the probe remain to be assigned.
              Kubernetes access and reserved resources are pending.
            </p>
          </div>
          <Link className="btn btn-primary" to="/infrastructure">
            Open pilot plan
          </Link>
        </section>
      )}
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
        sub="Scope and preparation · objective DRS 5"
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
                Client identity is fixed. Target scope and campaign history remain managed
                separately.
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
                  Shared two-PoP pilot, plus an independent probe. Client-specific placement and
                  collection are not yet qualified.
                </p>
                <Link className="btn btn-secondary" to="/infrastructure">
                  Review pilot prerequisites
                </Link>
              </section>
              <section className="card">
                <h2>Evidence and report</h2>
                <p>
                  Prototype reports are linked to this client below their simulation label. No
                  measured assessment evidence is bound yet; another client's score cannot establish
                  its DRS level.
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
        sub="Two PoPs and one independent probe · a qualification starting point, not a DRS 5 sizing guarantee"
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
          <p>Independent location and network path to document.</p>
          <p>No server, public source or capacity is assumed.</p>
        </section>
        <section className="card">
          <span className="workbench-eyebrow">Independent measurement</span>
          <h2>External probe</h2>
          <span className="workbench-tag">To provision</span>
          <p>Separate resources and observation path from the pilot node.</p>
          <p>Clock quality, functional reference and collector continuity remain to qualify.</p>
        </section>
      </div>
      <section className="workbench-next">
        <div>
          <h2>Next handoff to infrastructure</h2>
          <p>
            Provide the intended Kubernetes context and namespace, confirm the ac02 node label and
            resource reservation, then identify the second site and independent probe.
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
