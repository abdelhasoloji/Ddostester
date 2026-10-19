import { useEffect, useState } from 'react';
import { api, type DrsCapacityView, type DrsClientView } from './api.js';
import { useApp } from './context.js';
import { LineIcon } from './interface-kit.js';

/**
 * Client dossiers: the DRS assessments grouped by the client they belong to.
 *
 * The client is a display grouping, not an authorization boundary — a plan still has to
 * pass the target allowlist, the approval and the execute permission. Showing it here is
 * what turns a pile of assessments into a client file.
 */
export function ClientsPage() {
  const app = useApp();
  const [clients, setClients] = useState<DrsClientView[] | null>(null);
  const [capacity, setCapacity] = useState<DrsCapacityView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.drsClients().then((r) => {
        if (!cancelled) setClients(r.clients);
      }),
      api.drsCapacity().then((r) => {
        if (!cancelled) setCapacity(r);
      }),
    ]).catch((err) => {
      if (!cancelled) setError((err as Error).message);
    });
    return () => {
      cancelled = true;
    };
  }, [app.campaigns]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Clients</h1>
          <p className="hint">
            One dossier per client: their assessments, the targets covered and the last known state.
            A client is a grouping for the report, never a shortcut around authorization.
          </p>
        </div>
        <span className="page-head-icon" aria-hidden="true">
          <LineIcon name="shield" />
        </span>
      </div>

      {error && <p role="alert">{error}</p>}

      {capacity && (
        <p className="hint">
          Capacity: <b>{capacity.envelope.maxRps.toLocaleString()} rps</b> ·{' '}
          <b>{capacity.envelope.agents}</b> admitted agent(s) · bounded by{' '}
          <b>{capacity.envelope.limitedBy.rps}</b> · <a href="/capacity">calibrate or inspect</a>
        </p>
      )}

      {clients && clients.length === 0 && (
        <p className="hint">
          No DRS assessment yet. Create one from <a href="/capacity">Capacity</a>.
        </p>
      )}

      {clients && clients.length > 0 && (
        <table className="campaign-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Assessments</th>
              <th>Finalized</th>
              <th>Targets</th>
              <th>Last state</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.client}>
                <td>
                  <b>{c.client}</b>
                </td>
                <td>{c.assessments}</td>
                <td>{c.finalized}</td>
                <td className="hint">{c.targets.join(', ')}</td>
                <td>{c.lastState}</td>
                <td className="hint">{c.lastAt ? new Date(c.lastAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
