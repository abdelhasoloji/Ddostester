import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useApp } from './context.js';
import { Bar, Card, Chip, EmptyState, Kpi } from './design-system.js';

type Fleet = Awaited<ReturnType<typeof api.drsFleet>>;
type Agent = Fleet['agents'][number];

const STATE_TONE = { active: 'ok', maintenance: 'warn', retired: 'plain' } as const;

/**
 * The fleet decides the envelope. A generator that is in maintenance, retired, or measured too
 * long ago contributes nothing — and the page says which, instead of quietly shrinking capacity.
 */
export function DrsFleetPage() {
  const app = useApp();
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ id: '', label: '', region: '' });
  const [creating, setCreating] = useState(false);

  const load = () =>
    api
      .drsFleet()
      .then((f) => setFleet(f))
      .catch((err) => setError((err as Error).message));

  useEffect(() => {
    void load();
  }, []);

  const setState = async (id: string, state: Agent['state']) => {
    setBusy(id);
    try {
      await api.setDrsAgentState(id, state);
      app.push('success', `${id} is now ${state}.`);
      await load();
      await app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('register');
    try {
      await api.saveDrsAgent({
        id: form.id.trim(),
        label: form.label.trim(),
        ...(form.region.trim() ? { region: form.region.trim() } : {}),
      });
      app.push('success', `Agent ${form.label || form.id} registered.`);
      setCreating(false);
      setForm({ id: '', label: '', region: '' });
      await load();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p role="alert">{error}</p>;
  if (!fleet) return <p className="hint">Loading the fleet…</p>;

  const admitted = fleet.agents.filter((a) => a.admitted);
  const capacity = admitted.reduce((n, a) => n + a.measuredTps, 0);

  return (
    <>
      <div className="page-head page-head--icon">
        <div>
          <h1>Fleet</h1>
          <p className="hint">
            Generators that may contribute to an exposure. Only an active agent with a calibration
            younger than {fleet.ttlDays} days counts — everything else is listed with its reason.
          </p>
        </div>
      </div>

      <div className="kpis">
        <Kpi value={fleet.envelope.maxRps.toLocaleString()} label="envelope rps" />
        <Kpi value={admitted.length} label="admitted agents" />
        <Kpi value={capacity.toLocaleString()} label="calibrated rps" />
        <Kpi value={fleet.agents.length} label="agents known" />
      </div>

      <p className="hint">
        <button className="btn btn-sm" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : 'Register an agent'}
        </button>
      </p>

      {creating && (
        <Card>
          <form onSubmit={(e) => void register(e)}>
            <div className="grid2">
              <label className="field">
                Agent id
                <input
                  required
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  placeholder="gen-vps3"
                />
              </label>
              <label className="field">
                Label
                <input
                  required
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="Generator VPS 3"
                />
              </label>
              <label className="field">
                Region (optional)
                <input
                  value={form.region}
                  onChange={(e) => setForm({ ...form, region: e.target.value })}
                  placeholder="eu-west"
                />
              </label>
            </div>
            <button className="btn btn-sm btn-primary" disabled={busy === 'register'}>
              {busy === 'register' ? 'Registering…' : 'Register'}
            </button>
          </form>
        </Card>
      )}

      <h2>Agents</h2>
      {fleet.agents.length === 0 ? (
        <EmptyState
          title="No agent known"
          action={
            <a className="btn btn-sm" href="/capacity">
              Record a calibration
            </a>
          }
        >
          An agent appears here once it has been calibrated at least once.
        </EmptyState>
      ) : (
        <table className="campaign-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>State</th>
              <th>Measured</th>
              <th>Calibrated</th>
              <th>Admitted</th>
              <th>Contribution</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {fleet.agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <b>{a.label}</b>
                  <div className="hint">
                    {a.id}
                    {a.region ? ` · ${a.region}` : ''}
                    {a.registered ? '' : ' · no fleet record'}
                  </div>
                </td>
                <td>
                  <select
                    aria-label={`State of ${a.id}`}
                    value={a.state}
                    disabled={busy === a.id}
                    onChange={(e) => void setState(a.id, e.target.value as Agent['state'])}
                  >
                    <option value="active">active</option>
                    <option value="maintenance">maintenance</option>
                    <option value="retired">retired</option>
                  </select>{' '}
                  <Chip tone={STATE_TONE[a.state]}>{a.state}</Chip>
                </td>
                <td>
                  {a.measuredTps.toLocaleString()} rps · {a.measuredConcurrency} conc
                </td>
                <td className="hint">
                  {new Date(a.measuredAt).toLocaleDateString()}
                  {a.ageDays !== null ? ` · ${a.ageDays} d ago` : ''}
                </td>
                <td>
                  {a.admitted ? (
                    <Chip tone="ok">admitted</Chip>
                  ) : (
                    <Chip tone="warn">{a.excludedReason ?? 'excluded'}</Chip>
                  )}
                </td>
                <td>
                  {a.admitted ? (
                    <Bar value={Math.min(1, a.measuredTps / Math.max(1, fleet.envelope.maxRps))} />
                  ) : (
                    <span className="hint">{a.excludedDetail ?? '—'}</span>
                  )}
                </td>
                <td>
                  <a className="btn btn-sm" href="/capacity">
                    Calibrate
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
