import { useEffect, useState } from 'react';
import { api, type DrsCatalog } from './api.js';
import { useApp, canDo } from './context.js';
export function DrsCatalogPanel({
  target = '',
  deviceIds = [],
}: {
  target?: string;
  deviceIds?: string[];
}) {
  const app = useApp();
  const [data, setData] = useState<DrsCatalog>();
  const [error, setError] = useState('');
  const [level, setLevel] = useState('all');
  const [page, setPage] = useState(1);
  useEffect(() => {
    let live = true;
    void api
      .drsCatalog()
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
  if (error) return <p role="alert">DRS catalogue unavailable: {error}</p>;
  if (!data) return <p>Loading DRS catalogue…</p>;
  const filtered = data.profiles.filter((p) => level === 'all' || String(p.level) === level);
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 12, currentPage * 12);
  const fleetAvailable = app.agents.some((a) => a.id === 'fleet' && a.available);
  const editable = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  return (
    <section aria-label="DRS Fleet catalogue">
      <div className="card">
        <h2>DRS · Fleet campaigns</h2>
        <p>
          {data.reference} · {data.version}
        </p>
        <p>
          Choose a standard reference and a bounded laboratory approximation. Local generators and
          generic templates are retired.
        </p>
        <p className="hint">
          {data.scope}. {data.provenance}.
        </p>
        <div className="fleet-summary">
          <span>
            <b>{data.inventoryCaps.maxDevices.toLocaleString()}</b>registry capacity
          </span>
          <span>
            <b>{data.inventoryCaps.maxSites}</b>sites in inventory
          </span>
          <span>
            <b>{data.executionCaps.maxAgents}</b>active agents maximum
          </span>
          <span>
            <b>{data.executionCaps.maxRps}</b>requests/s shared ceiling
          </span>
        </div>
        <p>
          Inventory size never multiplies the traffic budget. Profiles unavailable to Fleet cannot
          fall back to Vegeta or the local generator.
        </p>
      </div>
      <div className="drs-catalog-controls">
        <label>
          Reference level
          <select
            value={level}
            onChange={(e) => {
              setLevel(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">All levels</option>
            {[1, 2, 3, 4, 5, 6, 7].map((l) => (
              <option key={l} value={l}>
                Level {l}
              </option>
            ))}
          </select>
        </label>
        <span>
          {filtered.length} vectors · page {currentPage} / {pages}
        </span>
        <button
          className="btn"
          disabled={currentPage === 1}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous vectors
        </button>
        <button
          className="btn"
          disabled={currentPage === pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next vectors
        </button>
      </div>
      <div className="drs-catalog-grid">
        {visible.map((p) => (
          <article className="card" key={p.id}>
            <span className={`engine-badge ${p.supported ? 'ok' : 'no'}`}>
              DRS {p.level ?? '—'} ·{' '}
              {p.supported ? 'GET laboratory approximation' : 'Not executable'}
            </span>
            <h3>{p.name}</h3>
            <p className="hint">Reference level {p.level}; this is not a measured score.</p>
            <p>{p.summary}</p>
            <p className="hint">{p.reason}</p>
            {editable && (
              <button
                className="btn btn-primary"
                disabled={!p.supported || !fleetAvailable}
                onClick={() => {
                  app.clearDraftPreset();
                  app.queueReplay({
                    name: p.name,
                    drsProfileId: p.id,
                    target,
                    probeUrl: target,
                    agent: 'fleet',
                    fleetDeviceIds: deviceIds,
                    maxRps: 3,
                    concurrency: 3,
                    maxDurationSec: 20,
                    profile: 'constant',
                    vector: 'http-get',
                  });
                }}
              >
                {p.supported ? 'Configure Fleet campaign' : 'Unsupported by current agents'}
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
