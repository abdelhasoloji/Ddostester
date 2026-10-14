import { useEffect, useState } from 'react';
import { api, type FleetStatus } from './api.js';

export function FleetLivePanel() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.fleetStatus();
        if (!disposed) {
          setStatus(next);
          setFailed(false);
        }
      } catch {
        if (!disposed) {
          setStatus(null);
          setFailed(true);
        }
      } finally {
        if (!disposed) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return (
    <section className="card" aria-label="Live fleet observation">
      <h3>Fleet observation</h3>
      {failed ? (
        <p role="status">Fleet observation unavailable. Check your connection and session.</p>
      ) : !status ? (
        <p role="status">Reading fleet coordinator…</p>
      ) : !status.configured ? (
        <p role="status">Fleet is not configured on this server.</p>
      ) : !status.available ? (
        <p role="status">Fleet coordinator cannot be read. Agent state is unknown.</p>
      ) : (
        <>
          <p className="hint">
            Observed at {status.observedAt ?? 'unknown'}. An expired lease does not prove process
            termination.
          </p>
          <p>
            Latest coordinator run: {status.run?.runId ?? 'none'} (
            {status.run?.state ?? 'no recorded run'}).
          </p>
          {status.run?.state === 'RUNNING' && status.run.controlLeaseExpired && (
            <p role="status">Control lease expired at observation.</p>
          )}
          <div
            className="fleet-table-scroll"
            role="region"
            aria-label="Fleet lease table"
            tabIndex={0}
          >
            <table className="fleet-table">
              <caption>Agent leases, budgets and last recorded progress</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Recorded state</th>
                  <th scope="col">Lease</th>
                  <th scope="col">Budget</th>
                  <th scope="col">Requests sent</th>
                </tr>
              </thead>
              <tbody>
                {status.agents?.map((agent) => (
                  <tr key={agent.agentId}>
                    <th scope="row">{agent.agentId}</th>
                    <td>{agent.state}</td>
                    <td>{agent.leaseExpired ? 'expired' : 'within lease at observation'}</td>
                    <td>
                      {agent.budget.maxRps} RPS · {agent.budget.concurrency} concurrent
                    </td>
                    <td>{agent.progress?.sent ?? 'unknown'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="fleet-identities">
            <summary>Configured image and attempt identities</summary>
            <p className="mono">{status.image ?? 'unknown'}</p>
            <ul>
              {status.agents?.map((agent) => (
                <li key={agent.agentId}>
                  {agent.agentId}: {agent.attemptId}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
