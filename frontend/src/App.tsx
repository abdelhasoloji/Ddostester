import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { Campaign } from './api.js';

const empty = {
  name: '',
  target: 'http://localhost:3000/',
  probeUrl: 'http://localhost:3000/health',
  vector: 'http-get',
  maxRps: 100,
  concurrency: 10,
  maxDurationSec: 60,
  createdBy: '',
  authorized: false,
};

export function App() {
  const [allowed, setAllowed] = useState<string[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [form, setForm] = useState({ ...empty });
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.listCampaigns().then(setCampaigns).catch((e) => setError(e.message));
  useEffect(() => {
    api.health().then((h) => setAllowed(h.allowedTargets)).catch(() => undefined);
    refresh();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createCampaign({ ...form, maxRps: Number(form.maxRps) });
      setForm({ ...empty });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main style={{ font: '15px system-ui', maxWidth: 960, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>WEDOS ShieldTest — Control Plane</h1>
      <p style={{ color: '#555' }}>
        Cibles autorisées&nbsp;: <code>{allowed.join(', ') || '—'}</code>. Générateur HTTP borné
        uniquement (pas de vecteurs volumétriques).
      </p>

      {error && (
        <p style={{ background: '#fde8e8', color: '#9b1c1c', padding: '.6rem 1rem', borderRadius: 6 }}>
          {error}
        </p>
      )}

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: '1rem', margin: '1rem 0' }}>
        <h2>Nouvelle campagne</h2>
        <form onSubmit={submit} style={{ display: 'grid', gap: '.6rem', gridTemplateColumns: '1fr 1fr' }}>
          <label>Nom<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Auteur<input required value={form.createdBy} onChange={(e) => setForm({ ...form, createdBy: e.target.value })} /></label>
          <label>Cible (URL)<input required value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} /></label>
          <label>Sonde (URL)<input required value={form.probeUrl} onChange={(e) => setForm({ ...form, probeUrl: e.target.value })} /></label>
          <label>Vecteur
            <select value={form.vector} onChange={(e) => setForm({ ...form, vector: e.target.value })}>
              <option value="http-get">http-get</option>
              <option value="http-post">http-post</option>
            </select>
          </label>
          <label>Max RPS<input type="number" value={form.maxRps} onChange={(e) => setForm({ ...form, maxRps: Number(e.target.value) })} /></label>
          <label>Concurrence<input type="number" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })} /></label>
          <label>Durée max (s)<input type="number" value={form.maxDurationSec} onChange={(e) => setForm({ ...form, maxDurationSec: Number(e.target.value) })} /></label>
          <label style={{ gridColumn: '1 / 3' }}>
            <input type="checkbox" checked={form.authorized} onChange={(e) => setForm({ ...form, authorized: e.target.checked })} />{' '}
            J'atteste que la cible est autorisée (interne WEDOS ou mandat écrit).
          </label>
          <button type="submit" style={{ gridColumn: '1 / 3' }}>Soumettre pour approbation</button>
        </form>
      </section>

      <h2>Campagnes</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>{['Nom', 'Cible', 'Statut', 'WRS', 'Actions'].map((h) => (
            <th key={h} style={{ textAlign: 'left', borderBottom: '2px solid #333', padding: '.4rem' }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '.4rem' }}>{c.name}</td>
              <td style={{ padding: '.4rem' }}><code>{c.target}</code></td>
              <td style={{ padding: '.4rem' }}>{c.status}</td>
              <td style={{ padding: '.4rem' }}>{c.wrs ? `${c.wrs.wrs} (${c.wrs.level})` : '—'}</td>
              <td style={{ padding: '.4rem', display: 'flex', gap: '.4rem' }}>
                {c.status === 'PENDING_APPROVAL' && (
                  <button onClick={() => act(() => api.approve(c.id, { approvedBy: 'officer@wedos', decision: 'APPROVED' }))}>
                    Approuver
                  </button>
                )}
                {c.status === 'APPROVED' && <button onClick={() => act(() => api.execute(c.id))}>Exécuter</button>}
                {c.status === 'RUNNING' && <button onClick={() => act(() => api.kill(c.id))}>Kill</button>}
                {c.runId && <a href={`/api/runs/${c.runId}/report`} target="_blank" rel="noreferrer">Rapport</a>}
              </td>
            </tr>
          ))}
          {campaigns.length === 0 && (
            <tr><td colSpan={5} style={{ padding: '1rem', color: '#777' }}>Aucune campagne.</td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
