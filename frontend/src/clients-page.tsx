import { useEffect, useState, type FormEvent } from 'react';
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
  const [creating, setCreating] = useState(false);
  const [busyCreate, setBusyCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    contactName: '',
    contactEmail: '',
    reference: '',
    signedAt: new Date().toISOString().slice(0, 10),
    targets: '',
    maxRps: '2000',
  });

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusyCreate(true);
    try {
      await api.createDrsClient({
        name: form.name,
        contacts: [{ name: form.contactName, email: form.contactEmail }],
        scope: {
          reference: form.reference,
          signedAt: new Date(form.signedAt).toISOString(),
          targets: form.targets
            .split('\n')
            .map((t) => t.trim())
            .filter(Boolean),
          maxRps: Number(form.maxRps),
        },
      });
      app.push('success', `Dossier ${form.name} created.`);
      setCreating(false);
      setForm({ ...form, name: '', contactName: '', contactEmail: '', reference: '', targets: '' });
      await app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusyCreate(false);
    }
  };

  return (
    <>
      <div className="page-head page-head--icon">
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

      <p className="hint">
        <button className="btn btn-sm" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : 'New client'}
        </button>
      </p>

      {creating && (
        <form className="card" onSubmit={(e) => void submit(e)} style={{ marginBottom: '1rem' }}>
          <div className="grid2">
            <label className="field">
              Client name
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Acme Payments"
              />
            </label>
            <label className="field">
              Scope reference
              <input
                required
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
                placeholder="SOW-2026-10"
              />
            </label>
            <label className="field">
              Contact name
              <input
                required
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                placeholder="S. Martin"
              />
            </label>
            <label className="field">
              Contact email
              <input
                required
                type="email"
                value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                placeholder="s.martin@acme.eu"
              />
            </label>
            <label className="field">
              Signed on
              <input
                required
                type="date"
                value={form.signedAt}
                onChange={(e) => setForm({ ...form, signedAt: e.target.value })}
              />
            </label>
            <label className="field">
              Ceiling (rps)
              <input
                required
                type="number"
                min="1"
                value={form.maxRps}
                onChange={(e) => setForm({ ...form, maxRps: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            Authorised targets, one per line
            <textarea
              required
              rows={3}
              value={form.targets}
              onChange={(e) => setForm({ ...form, targets: e.target.value })}
              placeholder={'https://pay.acme.eu\nhttps://api.acme.eu'}
            />
          </label>
          <button className="btn btn-sm btn-primary" disabled={busyCreate}>
            {busyCreate ? 'Creating…' : 'Create dossier'}
          </button>
        </form>
      )}

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
              <tr key={c.id ?? `legacy:${c.client}`}>
                <td>
                  {c.id ? (
                    <a href={`/clients/${c.id}`}>
                      <b>{c.client}</b>
                    </a>
                  ) : (
                    <>
                      <b>{c.client}</b>
                      <div className="hint">unregistered — legacy campaign name</div>
                    </>
                  )}
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
