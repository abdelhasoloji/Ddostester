import { useEffect, useState } from 'react';
import { api, type FleetDevice, type FleetMissionStatus } from './api.js';
export function FleetMissions({
  devices,
  editable,
  historyOnly = false,
}: {
  devices: FleetDevice[];
  editable: boolean;
  historyOnly?: boolean;
}) {
  const [status, setStatus] = useState<FleetMissionStatus>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [duration, setDuration] = useState(20);
  const [rps, setRps] = useState(3);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api.fleetMissions();
        if (live) {
          setStatus(value);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  const ready = devices.filter(
    (d) => d.connection === 'online' && d.agentVersion === 'fleet-mission-agent/v1',
  );
  const active = status?.missions.some((m) => m.snapshot && m.snapshot.state !== 'SETTLED');
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setStatus(await api.fleetMissions());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-label="Fleet missions">
      <h2>Fleet missions</h2>
      {error && <p role="alert">Mission refresh or command unavailable: {error}</p>}
      {!status ? (
        <p>Loading mission control…</p>
      ) : !status.enabled ? (
        <p>Mission control is not enabled on this installation.</p>
      ) : (
        <>
          <p>
            Authorized lab target: <code>{status.target}</code>. HTTP GET traffic; agents share the
            total request budget. Public source IP diversity is not simulated.
          </p>
          {editable && !historyOnly && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  !window.confirm(
                    `Launch ${duration}s of traffic from ${selected.length} agents to the dedicated lab target at ${rps} requests/s total?`,
                  )
                )
                  return;
                void action(() =>
                  api.launchFleetMission({
                    deviceIds: selected,
                    maxRps: rps,
                    concurrency: selected.length,
                    durationSec: duration,
                    confirmed: true,
                  }),
                );
              }}
            >
              <fieldset disabled={busy || !!active || !!error}>
                <legend>Select up to three online mission agents</legend>
                {!ready.length && <p>No mission-ready agent is online.</p>}
                {ready.map((d) => (
                  <label key={d.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(d.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, d.id]
                            : selected.filter((id) => id !== d.id),
                        )
                      }
                    />{' '}
                    {d.name} — {d.privateIp}
                  </label>
                ))}
                <label>
                  Total requests per second{' '}
                  <input
                    type="number"
                    min={Math.max(1, selected.length)}
                    max={status.caps.maxRps}
                    value={rps}
                    onChange={(e) => setRps(Number(e.target.value))}
                  />
                </label>
                <label>
                  Duration in seconds{' '}
                  <input
                    type="number"
                    min={10}
                    max={status.caps.maxDurationSec}
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                  />
                </label>
                <button disabled={!selected.length || selected.length > 3 || rps < selected.length}>
                  Launch lab mission
                </button>
              </fieldset>
            </form>
          )}
          {status.missions.map((m) => (
            <article key={m.id}>
              <h3>
                Mission {m.id.slice(0, 8)} — {m.snapshot?.state ?? 'unknown'}
              </h3>
              <p>
                {new Date(m.createdAt).toLocaleString()} · {m.maxRps} requests/s total ·{' '}
                {m.durationSec}s
              </p>
              {editable && m.snapshot?.state !== 'SETTLED' && (
                <button
                  disabled={busy}
                  onClick={() => void action(() => api.stopFleetMission(m.id))}
                >
                  Stop mission
                </button>
              )}
              <table>
                <caption>Agent results and acknowledged execution states</caption>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>State</th>
                    <th>Requests</th>
                    <th>Successful</th>
                    <th>Failed</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {m.snapshot?.shards.map((s) => (
                    <tr key={s.agentId}>
                      <th>{s.agentId}</th>
                      <td>{s.state}</td>
                      <td>{s.result?.generator?.totalRequests ?? s.progress?.sent ?? '—'}</td>
                      <td>{s.result?.generator?.successful ?? s.progress?.successful ?? '—'}</td>
                      <td>{s.result?.generator?.failed ?? s.progress?.failed ?? '—'}</td>
                      <td>{s.result?.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                Counters are reported by agents. LOST means the final outcome is unknown; STOPPING
                is an order awaiting acknowledgment. No resilience score is inferred from these
                counters.
              </p>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
