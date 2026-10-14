import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type FleetOverview } from './api.js';
export function FleetOperations({
  compact = false,
  editable = false,
}: {
  compact?: boolean;
  editable?: boolean;
}) {
  const [data, setData] = useState<FleetOverview>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const navigate = useNavigate();
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.fleetOverview();
        if (
          !Array.isArray(next.devices) ||
          !Array.isArray(next.missions) ||
          !Array.isArray(next.origins) ||
          !next.caps
        )
          throw new Error('Invalid Fleet observation');
        if (live) {
          setData(next);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  const devices = data?.devices.filter((d) => data.group === '*' || d.group === data.group) ?? [];
  const ready = devices.filter((d) => d.connection === 'online' && d.missionCapable);
  const active = data?.missions.filter((m) => m.snapshot && m.snapshot.state !== 'SETTLED') ?? [];
  const busyIds = new Set(active.flatMap((m) => m.deviceIds));
  const attention = devices.filter(
    (d) =>
      d.connection !== 'online' ||
      (d.enrollmentExpiresAt && Date.parse(d.enrollmentExpiresAt) - Date.now() < 86400000),
  );
  const canLaunch =
    data?.enabled &&
    !error &&
    !active.length &&
    selected.length > 0 &&
    selected.length <= 3 &&
    selected.every((id) => ready.some((d) => d.id === id));
  return (
    <section className="card" aria-label="IoT fleet operations">
      <div className="fleet-toolbar">
        <h2>IoT fleet operations</h2>
        {compact && <Link to="/fleet">Manage fleet →</Link>}
      </div>
      {error ? (
        <p role="alert">Fleet observation unavailable; availability is unknown. {error}</p>
      ) : !data ? (
        <p>Reading enrolled fleet…</p>
      ) : (
        <>
          <div className="fleet-summary">
            <span>
              <b>{ready.length}</b> ready
            </span>
            <span>
              <b>{busyIds.size}</b> assigned
            </span>
            <span>
              <b>{attention.length}</b> need attention
            </span>
            <span>
              <b>{active.length}</b> active campaigns
            </span>
          </div>
          {!data.enabled && <p>Campaign execution is disabled on this installation.</p>}
          <p className="hint">
            Observed {new Date(data.observedAt).toLocaleTimeString()}. Up to three devices share{' '}
            {data.caps.maxRps} RPS and {data.caps.maxConcurrency} workers, for at most{' '}
            {data.caps.maxDurationSec}s. Private pod IPs do not guarantee distinct public source
            IPs; verify egress per site.
          </p>
          <p className="hint">
            Enabled target origins: {data.origins.join(', ') || 'none'}. Enrollment expiry is
            separate from certificate expiry.
          </p>
          {active.map((m) => (
            <p key={m.id}>
              <Link to={`/theater?run=${m.campaignId}`}>{m.name} → Run Theater</Link> ·{' '}
              {m.snapshot?.state}
            </p>
          ))}
          {data.inventoryCount !== undefined && data.inventoryCount > data.devices.length && (
            <p className="hint">
              Preparation view: first {data.devices.length} of {data.inventoryCount} agents. Use the
              paginated site inventory and DRS campaign selection for the full registry.
            </p>
          )}
          {!compact && (
            <>
              <div className="fleet-table-scroll">
                <table className="fleet-table">
                  <caption>Campaign preparation and device capabilities</caption>
                  <thead>
                    <tr>
                      {editable && <th>Select</th>}
                      <th>Device</th>
                      <th>Profile / behavior</th>
                      <th>Execution</th>
                      <th>Enrollment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.id}>
                        {editable && (
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select ${d.name} for campaign`}
                              checked={selected.includes(d.id)}
                              disabled={!ready.some((r) => r.id === d.id) || busyIds.has(d.id)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, d.id]
                                    : selected.filter((id) => id !== d.id),
                                )
                              }
                            />
                          </td>
                        )}
                        <th>
                          {d.name}
                          <br />
                          <small>{d.privateIp}</small>
                        </th>
                        <td>
                          {d.profile}
                          <br />
                          <small>
                            {d.supportedMethods.length
                              ? d.supportedMethods.join(', ') + ' only'
                              : 'Presence client only'}
                            ; business profiles pending
                          </small>
                        </td>
                        <td>
                          {busyIds.has(d.id)
                            ? 'Assigned'
                            : d.connection === 'online' && d.missionCapable
                              ? 'Ready'
                              : (d.connection ?? 'unknown')}
                        </td>
                        <td>
                          {d.enrollmentExpiresAt
                            ? `Expires ${new Date(d.enrollmentExpiresAt).toLocaleString()}`
                            : 'Not enrolled'}
                          <br />
                          <small>Certificate expiry is not reported by this client.</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {editable && (
                <button
                  className="btn btn-primary"
                  disabled={!canLaunch}
                  onClick={() =>
                    navigate(
                      '/campaigns?' +
                        new URLSearchParams({ engine: 'fleet', devices: selected.join(',') }),
                    )
                  }
                >
                  Create campaign with selected agents
                </button>
              )}
              {selected.length > 3 && <p role="alert">Select at most three agents.</p>}
              {attention.length > 0 && (
                <p className="hint">
                  Check presence and enrollment for {attention.map((d) => d.name).join(', ')} in
                  device maintenance below.
                </p>
              )}
              <details>
                <summary>Recent Fleet campaigns</summary>
                {data.missions.length ? (
                  data.missions.map((m) => (
                    <p key={m.id}>
                      <Link to={`/theater?run=${m.campaignId}`}>{m.name}</Link> ·{' '}
                      {m.snapshot?.state ?? 'unknown'} · {new Date(m.createdAt).toLocaleString()}
                    </p>
                  ))
                ) : (
                  <p>No recorded Fleet campaign.</p>
                )}
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
