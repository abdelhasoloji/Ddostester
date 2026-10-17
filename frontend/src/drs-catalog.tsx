import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
  const [source, setSource] = useState('synthetic');
  const [data, setData] = useState<DrsCatalog>();
  const [error, setError] = useState('');
  const [level, setLevel] = useState('all');
  const [page, setPage] = useState(1);
  const [showAll, setShowAll] = useState(true);
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
    (p) =>
      (showAll || (source === 'synthetic' ? (p.level ?? Infinity) <= 5 : p.supported)) &&
      (level === 'all' || String(p.level) === level),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 12, currentPage * 12);
  const fleetAvailable = app.agents.some((a) => a.id === 'fleet' && a.available);
  const canBench = canDo(app.role, 'bench', app.authRequired, app.userMode, app.capabilities);
  const editable = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  return (
    <section aria-label="DRS reference catalogue">
      <div className="card">
        <h2>DRS scenario catalogue</h2>
        <p>
          Complete reference · bounded laboratory approximations{' '}
          <HelpTip label="Campaign scope">
            The full reference catalogue includes unavailable generators. Executable profiles are
            bounded laboratory approximations, not a measured DRS level. The target, agents and
            shared limits are reviewed before explicit confirmation.
          </HelpTip>
        </p>
        {source === 'fleet' && !fleetAvailable && (
          <p role="status">
            Fleet generator unavailable. Check Infrastructure before preparing a campaign.
          </p>
        )}
        {!filtered.length && (
          <p role="status">
            No matching approximation at this level. Show the full catalogue to see all
            requirements.
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
          Execution source
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPage(1);
            }}
          >
            <option value="synthetic">Bounded synthetic bench</option>
            <option value="fleet">HTTP Fleet</option>
          </select>
        </label>
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
            <span
              className={`engine-badge ${(source === 'synthetic' ? (p.level ?? Infinity) <= 5 : p.supported) ? 'ok' : 'no'}`}
            >
              DRS {p.level ?? '—'} ·{' '}
              {source === 'synthetic'
                ? p.laboratory
                  ? 'Lab measurement · partial shape'
                  : (p.level ?? Infinity) <= 5
                    ? 'Simulation · no traffic'
                    : 'Reference only'
                : p.supported
                  ? 'GET laboratory approximation'
                  : 'Generator missing'}
            </span>
            <h3>{p.name}</h3>
            <p className="hint">Reference level {p.level}; this is not a measured score.</p>
            <p>{p.summary}</p>
            <p className="hint">
              {source === 'synthetic'
                ? 'Synthetic scenarios reproduce selected shapes only, not the full DRS exposure.'
                : p.reason}
            </p>
            {source === 'synthetic' && (
              <>
                {p.laboratory ? (
                  <>
                    <p className="hint">{p.laboratory.representedDimensions.join('; ')}</p>
                    <HelpTip label="Synthetic limitations">
                      {p.laboratory.missingDimensions.join('; ')}. Actual received counters are
                      never multiplied for scoring.
                    </HelpTip>
                  </>
                ) : (
                  <p className="hint">
                    Reference lifecycle simulation only. No traffic or measured service behavior.
                  </p>
                )}
                {canBench && (p.level ?? Infinity) <= 5 && (
                  <Link
                    className="btn btn-primary"
                    to={'/campaigns?tab=manager&source=synthetic&level=' + p.level}
                  >
                    Prepare synthetic campaign
                  </Link>
                )}
              </>
            )}
            {source === 'fleet' && editable && (
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
