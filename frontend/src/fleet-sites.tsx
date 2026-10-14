import { useEffect, useState } from 'react';
import { api } from './api.js';
export function FleetSitesPanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.fleetSites>>>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const d = await api.fleetSites();
        if (live) {
          setData(d);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return (
    <section className="card" aria-label="Fleet site inventory">
      <h2>Multisite inventory</h2>
      <p>
        Registry capacity: {data?.limits.maxDevices.toLocaleString() ?? '—'} agents across{' '}
        {data?.limits.maxSites ?? '—'} sites. This is not a validated simultaneous execution
        capacity.
      </p>
      {error ? (
        <p role="alert">Site observation unavailable: {error}</p>
      ) : data ? (
        <>
          <div className="fleet-summary">
            <span>
              <b>{data.devices}</b>registered agents
            </span>
            <span>
              <b>{data.sites.length}</b>registered sites
            </span>
            <span>
              <b>{data.sites.reduce((n, s) => n + s.online, 0)}</b>online agents
            </span>
          </div>
          <div className="fleet-table-scroll">
            <table className="fleet-table">
              <caption>Registered sites — not Kubernetes deployment status</caption>
              <thead>
                <tr>
                  <th>Site ID</th>
                  <th>Agents</th>
                  <th>Online</th>
                </tr>
              </thead>
              <tbody>
                {data.sites.map((s) => (
                  <tr key={s.id}>
                    <th>{s.id}</th>
                    <td>{s.devices}</td>
                    <td>{s.online}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p>Loading sites…</p>
      )}
    </section>
  );
}
