import { useEffect, useState } from 'react';
import { HelpTip } from './help-tip.js';
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
  const [showAll, setShowAll] = useState(false);
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
  const filtered = data.profiles.filter(
    (p) => (showAll || p.supported) && (level === 'all' || String(p.level) === level),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 12, currentPage * 12);
  const fleetAvailable = app.agents.some((a) => a.id === 'fleet' && a.available);
  const editable = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  return (
    <section aria-label="DRS Fleet catalogue">
      <div className="card">
        <h2>Choose a test profile</h2>
        <p>
          Fleet · bounded HTTP test{' '}
          <HelpTip label="Test scope">
            Profiles below are executable laboratory approximations, not a measured DRS level. The
            target, agents and shared limits are reviewed before explicit confirmation.
          </HelpTip>
        </p>
        {!fleetAvailable && (
          <p role="status">
            Fleet generator unavailable. Check Infrastructure before preparing a test.
          </p>
        )}
        {!filtered.length && (
          <p role="status">
            No executable profile at this level. Choose another level or show the full catalogue.
          </p>
        )}
        <details>
          <summary>Reference and capacity details</summary>
          <p>
            {data.reference} · {data.version}
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
          <p className="hint">Inventory size does not increase the shared traffic budget.</p>
        </details>
      </div>
      <div className="drs-catalog-controls">
        <label>
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => {
              setShowAll(e.target.checked);
              setPage(1);
            }}
          />
          Show full catalogue
        </label>
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
