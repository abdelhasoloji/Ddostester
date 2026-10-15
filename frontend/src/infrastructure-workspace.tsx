import { PassivePrototypePanel } from './passive-prototype-panel.js';
import { useRef, useState, useEffect } from 'react';
import { api } from './api.js';
import type {
  InfrastructureHost,
  InfrastructureWorkspace,
  InfrastructureGate,
} from './infrastructure-types.js';
const blank: InfrastructureHost = {
  siteId: '',
  name: '',
  architecture: null,
  os: null,
  runtime: null,
  cores: null,
  memoryGiB: null,
  nicModel: null,
  linkGbps: null,
  managementInterface: null,
  dataInterface: null,
  managementAddress: null,
  publicAddresses: [],
  observedEgressAddresses: [],
  notes: '',
};
const gates: InfrastructureGate[] = [
  'architecture',
  'runtime',
  'nic',
  'management',
  'data-egress',
  'clock',
  'independent-probe',
  'stop-receipt',
];
export function InfrastructureWorkspacePanel({ editable }: { editable: boolean }) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<InfrastructureWorkspace>();
  const [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false),
    [draft, setDraft] = useState<InfrastructureHost>();
  const [id, setId] = useState(''),
    [revision, setRevision] = useState(0);
  const [evidenceHost, setEvidenceHost] = useState(''),
    [gate, setGate] = useState<InfrastructureGate>('architecture');
  const [outcome, setOutcome] = useState<'pass' | 'fail' | 'unknown'>('unknown'),
    [content, setContent] = useState(''),
    [observedAt, setObservedAt] = useState('');
  const [history, setHistory] = useState('');
  const [addressText, setAddressText] = useState({
    publicAddresses: '',
    observedEgressAddresses: '',
  });
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function load(hosts = selected) {
    const current = ++request.current;
    setBusy(true);
    setError('');
    try {
      const result = await api.infrastructure(hosts);
      if (current === request.current) setData(result);
    } catch (e) {
      if (current === request.current) {
        setData(undefined);
        setError((e as Error).message);
      }
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  async function saveHost() {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api.saveInfrastructureHost(id, revision, {
        ...draft,
        publicAddresses: addressText.publicAddresses
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        observedEgressAddresses: addressText.observedEgressAddresses
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      });
      setDraft(undefined);
      setMessage('Host revision saved.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveEvidence() {
    const host = data?.hosts.find((h) => h.id === evidenceHost);
    if (!host || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api.addInfrastructureEvidence({
        hostId: host.id,
        profileHash: host.hash,
        gate,
        outcome,
        content,
        observedAt: new Date(observedAt).toISOString(),
      });
      setContent('');
      setMessage('Attestation retained; no hardware qualification was granted.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="Infrastructure qualification">
      <h2>Infrastructure readiness</h2>
      <p>Prepare the two-server assessment: inventory, operator evidence and DRS coverage.</p>
      <button
        disabled={busy}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        {open ? 'Close infrastructure workspace' : 'Open infrastructure workspace'}
      </button>
      {open && (
        <>
          {error && <p role="alert">Infrastructure unavailable: {error}</p>}
          {message && <p role="status">{message}</p>}
          <button disabled={busy} onClick={() => void load()}>
            Refresh infrastructure
          </button>
          {busy && <p role="status">Loading or saving infrastructure…</p>}
          {data && (
            <>
              {data.passivePrototype && (
                <PassivePrototypePanel checkpoint={data.passivePrototype} />
              )}
              <h3>Physical hosts</h3>
              <p>
                {data.hosts.length} hosts recorded. Unknown specifications remain empty. No host is
                prefilled from the declared estate.
              </p>
              {editable && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setId('');
                    setRevision(0);
                    setDraft({ ...blank });
                    setAddressText({ publicAddresses: '', observedEgressAddresses: '' });
                  }}
                >
                  Add physical host
                </button>
              )}
              <div className="fleet-table-scroll">
                <table className="fleet-table">
                  <caption>Infrastructure inventory — declared specifications</caption>
                  <thead>
                    <tr>
                      <th>Pilot</th>
                      <th>Host / site</th>
                      <th>Architecture / OS</th>
                      <th>NIC / link</th>
                      <th>Revision</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.hosts.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select pilot ${h.id}`}
                            checked={selected.includes(h.id)}
                            disabled={busy || (!selected.includes(h.id) && selected.length === 2)}
                            onChange={() => {
                              const next = selected.includes(h.id)
                                ? selected.filter((v) => v !== h.id)
                                : [...selected, h.id];
                              setSelected(next);
                              void load(next);
                            }}
                          />
                        </td>
                        <th scope="row">
                          {h.payload.name}
                          <br />
                          <small>
                            {h.id} · {h.payload.siteId}
                          </small>
                        </th>
                        <td>
                          {h.payload.architecture ?? 'Unknown'} / {h.payload.os ?? 'Unknown'}
                        </td>
                        <td>
                          {h.payload.nicModel ?? 'Unknown'} /{' '}
                          {h.payload.linkGbps === null
                            ? 'Unknown'
                            : `${h.payload.linkGbps} Gbit/s (declared)`}
                        </td>
                        <td>{h.revision}</td>
                        <td>
                          {editable && (
                            <button
                              disabled={busy}
                              onClick={() => {
                                setId(h.id);
                                setRevision(h.revision);
                                setDraft(structuredClone(h.payload));
                                setAddressText({
                                  publicAddresses: h.payload.publicAddresses.join(', '),
                                  observedEgressAddresses:
                                    h.payload.observedEgressAddresses.join(', '),
                                });
                              }}
                            >
                              Edit host {h.id}
                            </button>
                          )}{' '}
                          <button
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              setError('');
                              try {
                                const result = await api.infrastructureHistory('host', h.id);
                                setHistory(JSON.stringify(result, null, 2));
                              } catch (e) {
                                setError((e as Error).message);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            History {h.id}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Two-server evidence register · {data.qualification.status}</h3>
              <p>{data.qualification.scope}</p>
              {selected.length !== 2 && (
                <p>Select two distinct physical hosts to review the pilot prerequisites.</p>
              )}
              {data.qualification.selectedHosts.map((host) => (
                <div key={host.id}>
                  <h4>
                    {host.id} · {host.status}
                  </h4>
                  <ul>
                    {host.gates.map((g) => (
                      <li key={g.gate}>
                        {g.gate}: <strong>{g.status}</strong>
                        {g.evidenceId && <small> · receipt {g.evidenceId}</small>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {editable && data.hosts.length > 0 && (
                <form
                  aria-label="Record infrastructure evidence"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveEvidence();
                  }}
                >
                  <h4>Record an operator attestation</h4>
                  <p>
                    Paste sanitized evidence only. The server records its hash, actor and timestamp;
                    content is not independently verified.
                  </p>
                  <label>
                    Evidence host
                    <select
                      required
                      value={evidenceHost}
                      onChange={(e) => setEvidenceHost(e.target.value)}
                    >
                      <option value="">Choose host</option>
                      {data.hosts.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.id}
                        </option>
                      ))}
                    </select>
                  </label>{' '}
                  <label>
                    Qualification gate
                    <select
                      value={gate}
                      onChange={(e) => setGate(e.target.value as InfrastructureGate)}
                    >
                      {gates.map((g) => (
                        <option key={g}>{g}</option>
                      ))}
                    </select>
                  </label>{' '}
                  <label>
                    Observation outcome
                    <select
                      value={outcome}
                      onChange={(e) => setOutcome(e.target.value as typeof outcome)}
                    >
                      {['unknown', 'fail', 'pass'].map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </label>{' '}
                  <label>
                    Observed at (local time)
                    <input
                      required
                      type="datetime-local"
                      value={observedAt}
                      onChange={(e) => setObservedAt(e.target.value)}
                    />
                  </label>
                  <label>
                    Sanitized evidence
                    <textarea
                      required
                      maxLength={data.limits.maxEvidenceChars}
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                    />
                  </label>
                  <button disabled={busy} type="submit">
                    Save attestation
                  </button>
                </form>
              )}
              <details>
                <summary>Retained evidence ({data.evidence.length})</summary>
                {data.evidence.map((e) => (
                  <article key={e.id}>
                    <h4>
                      {e.payload.hostId} · {e.payload.gate} · {e.payload.outcome}
                    </h4>
                    <p>
                      {e.actor} · observed {e.payload.observedAt} · recorded {e.at}
                    </p>
                    <p>
                      SHA-256: <code>{e.hash}</code>
                    </p>
                    <pre>{e.payload.content}</pre>
                  </article>
                ))}
              </details>
              <h3>DRS level-5 readiness</h3>
              <p>
                DRS {data.readiness.standardVersion} · {data.readiness.fullPhysicalVectorsQualified}{' '}
                full physical vectors qualified. {data.readiness.scope}.
              </p>
              <p>
                Catalogue SHA-256: <code>{data.readiness.catalogueHash}</code>
              </p>
              <table className="fleet-table">
                <caption>Product coverage through level 5</caption>
                <thead>
                  <tr>
                    <th>Level</th>
                    <th>Reference vectors</th>
                    <th>Bounded HTTP approximations</th>
                    <th>Full physical qualified</th>
                  </tr>
                </thead>
                <tbody>
                  {data.readiness.levels.map((l) => (
                    <tr key={l.level}>
                      <th>{l.level}</th>
                      <td>{l.total}</td>
                      <td>{l.boundedHttp}</td>
                      <td>{l.physicalQualified}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <details>
                <summary>Source vectors and remaining gaps</summary>
                <table className="fleet-table">
                  <thead>
                    <tr>
                      <th>Vector</th>
                      <th>Source</th>
                      <th>Implementation</th>
                      <th>Physical evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.readiness.vectors.map((v) => (
                      <tr key={v.id}>
                        <th>{v.name}</th>
                        <td>
                          {v.sourceVectorId} · page {v.sourcePage} · {v.ambiguityCount} ambiguities
                        </td>
                        <td>{v.adapter}</td>
                        <td>{v.fullPhysicalStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          )}
          {draft && (
            <form
              aria-label="Physical host profile"
              onSubmit={(e) => {
                e.preventDefault();
                void saveHost();
              }}
            >
              <h3>{revision ? `Edit ${id} · revision ${revision}` : 'Register a physical host'}</h3>
              <div className="fleet-form-grid">
                <label>
                  Stable host ID
                  <input
                    required
                    pattern="[a-z0-9][a-z0-9-]{0,63}"
                    maxLength={64}
                    disabled={revision > 0}
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                  />
                </label>
                <label>
                  Host architecture
                  <select
                    value={draft.architecture ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        architecture: (e.target.value ||
                          null) as InfrastructureHost['architecture'],
                      })
                    }
                  >
                    <option value="">Unknown</option>
                    <option value="arm64">ARM64</option>
                    <option value="amd64">AMD64</option>
                  </select>
                </label>
                {(
                  [
                    'name',
                    'siteId',
                    'os',
                    'runtime',
                    'nicModel',
                    'managementInterface',
                    'dataInterface',
                    'managementAddress',
                    'notes',
                  ] as const
                ).map((key) => (
                  <label key={key}>
                    {
                      {
                        name: 'Host name',
                        siteId: 'Host site ID',
                        os: 'Operating system',
                        runtime: 'Container / Kubernetes runtime',
                        nicModel: 'NIC model',
                        managementInterface: 'Management interface',
                        dataInterface: 'Data interface',
                        managementAddress: 'VPN management IP',
                        notes: 'Host notes',
                      }[key]
                    }
                    <input
                      required={key === 'name' || key === 'siteId'}
                      maxLength={key === 'notes' ? 2000 : 100}
                      value={draft[key] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    />
                  </label>
                ))}
                {(['cores', 'memoryGiB', 'linkGbps'] as const).map((key) => (
                  <label key={key}>
                    {
                      {
                        cores: 'CPU cores',
                        memoryGiB: 'Memory (GiB)',
                        linkGbps: 'Declared link (Gbit/s)',
                      }[key]
                    }
                    <input
                      type="number"
                      min="0.001"
                      max="10000000"
                      step="any"
                      value={draft[key] ?? ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          [key]: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                ))}
                {(['publicAddresses', 'observedEgressAddresses'] as const).map((key) => (
                  <label key={key}>
                    {key === 'publicAddresses'
                      ? 'Allocated public IPs (comma separated)'
                      : 'Observed egress IPs (comma separated)'}
                    <input
                      value={addressText[key]}
                      onChange={(e) => setAddressText({ ...addressText, [key]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <button disabled={busy} type="submit">
                Save host revision
              </button>{' '}
              <button disabled={busy} type="button" onClick={() => setDraft(undefined)}>
                Cancel host edit
              </button>
            </form>
          )}
          {history && (
            <details open>
              <summary>Retained host revisions</summary>
              <pre>{history}</pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}
