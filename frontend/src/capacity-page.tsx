import { useCallback, useEffect, useState } from 'react';
import { api, type DrsCapacityView } from './api.js';
import { useApp } from './context.js';
import { LineIcon } from './interface-kit.js';

/**
 * Capacity: what the fleet can actually apply, and what that means for each
 * archived DRS level. Everything here is derived from recorded calibrations — an
 * agent that has not measured itself contributes nothing.
 */
export function CapacityPage() {
  const app = useApp();
  const [view, setView] = useState<DrsCapacityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    agentId: '',
    measuredTps: '',
    measuredConcurrency: '',
    measuredAt: new Date().toISOString().slice(0, 16),
    conditions: '',
  });

  const load = useCallback(async () => {
    try {
      setView(await api.drsCapacity());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.saveCalibration({
        agentId: form.agentId.trim(),
        measuredTps: Number(form.measuredTps),
        measuredConcurrency: Number(form.measuredConcurrency),
        measuredAt: new Date(form.measuredAt).toISOString(),
        conditions: form.conditions.trim() || undefined,
      });
      app.push('success', 'Calibration recorded.');
      setForm({ ...form, agentId: '', measuredTps: '', measuredConcurrency: '', conditions: '' });
      await load();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canWrite = !app.authRequired || app.capabilities.includes('campaign:approve');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Capacity</h1>
          <p className="hint">
            Measured generation capacity and the DRS levels it can actually reach. An agent that has
            not recorded a calibration contributes nothing.
          </p>
        </div>
        <span className="page-head-icon" aria-hidden="true">
          <LineIcon name="fleet" />
        </span>
      </div>

      {error && <p role="alert">{error}</p>}

      {view && (
        <>
          <div className="kpis">
            <div className="kpi">
              <div className="kpi-value">{view.envelope.maxRps.toLocaleString()}</div>
              <div className="kpi-label">rps envelope</div>
            </div>
            <div className="kpi">
              <div className="kpi-value">{view.envelope.maxConcurrency.toLocaleString()}</div>
              <div className="kpi-label">concurrent ceiling</div>
            </div>
            <div className="kpi">
              <div className="kpi-value">{view.envelope.agents}</div>
              <div className="kpi-label">admitted agents</div>
            </div>
            <div className="kpi">
              <div className="kpi-value">{view.ceiling.maxRps.toLocaleString()}</div>
              <div className="kpi-label">service ceiling</div>
            </div>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-head">
              <b>Bounded by</b>
            </div>
            <p className="hint">
              rate: <b>{view.envelope.limitedBy.rps}</b> · concurrency:{' '}
              <b>{view.envelope.limitedBy.concurrency}</b>
            </p>
            {view.envelope.warnings.length > 0 && (
              <ul className="hint">
                {view.envelope.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-head">
              <b>Archived levels this envelope can reach</b>
            </div>
            <table className="campaign-table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Vectors</th>
                  <th>Reachable</th>
                  <th>Missing (examples)</th>
                </tr>
              </thead>
              <tbody>
                {view.reachability.map((r) => (
                  <tr key={r.level}>
                    <td>DRS {r.level}</td>
                    <td>{r.total}</td>
                    <td>
                      {r.reachable}/{r.total}
                    </td>
                    <td className="hint">
                      {r.unreachable.length === 0
                        ? '—'
                        : r.unreachable
                            .slice(0, 2)
                            .map((u) => `${u.vectorId}: ${u.missing.join(', ')}`)
                            .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-head">
              <b>Admitted agents</b>
            </div>
            {view.calibrations.length === 0 ? (
              <p className="hint">No calibration recorded yet — the envelope is zero.</p>
            ) : (
              <table className="campaign-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>rps</th>
                    <th>Concurrent</th>
                    <th>Measured</th>
                    <th>Conditions</th>
                  </tr>
                </thead>
                <tbody>
                  {view.calibrations.map((c) => (
                    <tr key={c.agentId}>
                      <td>{c.agentId}</td>
                      <td>{c.measuredTps.toLocaleString()}</td>
                      <td>{c.measuredConcurrency.toLocaleString()}</td>
                      <td className="hint">{new Date(c.measuredAt).toLocaleString()}</td>
                      <td className="hint">{c.conditions ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {canWrite && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <div className="card-head">
                <b>Record a calibration</b>
              </div>
              <p className="hint">
                A calibration is a measured claim: the rate this agent sustained, under the stated
                conditions.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', alignItems: 'end' }}>
                <label>
                  Agent
                  <input
                    value={form.agentId}
                    onChange={(e) => setForm({ ...form, agentId: e.target.value })}
                    placeholder="site-a"
                  />
                </label>
                <label>
                  rps
                  <input
                    type="number"
                    value={form.measuredTps}
                    onChange={(e) => setForm({ ...form, measuredTps: e.target.value })}
                  />
                </label>
                <label>
                  Concurrent
                  <input
                    type="number"
                    value={form.measuredConcurrency}
                    onChange={(e) => setForm({ ...form, measuredConcurrency: e.target.value })}
                  />
                </label>
                <label>
                  Measured at
                  <input
                    type="datetime-local"
                    value={form.measuredAt}
                    onChange={(e) => setForm({ ...form, measuredAt: e.target.value })}
                  />
                </label>
                <label>
                  Conditions
                  <input
                    value={form.conditions}
                    onChange={(e) => setForm({ ...form, conditions: e.target.value })}
                    placeholder="TLS on, 12 ms RTT"
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || !form.agentId || !form.measuredTps}
                  onClick={() => void submit()}
                >
                  {busy ? 'Recording…' : 'Record'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
