import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Campaign, type DrsClientDocument } from './api.js';
import { useApp } from './context.js';

/**
 * A client dossier: the signed scope, the contacts, and every assessment run for that client.
 * The scope is a contract reference, not a permission — the allowlist and the approvals still
 * decide what may run.
 */
export function ClientPage() {
  const { id = '' } = useParams();
  const app = useApp();
  const navigate = useNavigate();
  const [client, setClient] = useState<DrsClientDocument | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .drsClient(id)
      .then((r) => {
        if (cancelled) return;
        setClient(r.client);
        setCampaigns(r.campaigns);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, app.campaigns]);

  if (error) return <p role="alert">{error}</p>;
  if (!client) return <p className="hint">Loading dossier…</p>;

  const measured = campaigns.filter((c) => c.drsDocument?.revisions.some((r) => r.finalizedAt));
  const unmet = measured.length;

  return (
    <>
      <div className="page-head page-head--icon">
        <div>
          <h1>{client.name}</h1>
          <p className="hint">
            {client.scope?.reference ?? 'no signed scope'} · signed{' '}
            {client.scope ? new Date(client.scope.signedAt).toLocaleDateString() : '—'}
          </p>
        </div>
        <span className="page-head-icon" aria-hidden="true">
          <LineIcon name="shield" />
        </span>
      </div>

      <div className="grid2">
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Signed scope</h2>
          <p className="hint">
            Contractual reference. A campaign target must appear here and the requested rate is
            capped by the ceiling below.
          </p>
          <table className="campaign-table">
            <tbody>
              <tr>
                <td>Reference</td>
                <td>{client.scope?.reference ?? '—'}</td>
              </tr>
              <tr>
                <td>Ceiling</td>
                <td>{client.scope ? `${client.scope.maxRps.toLocaleString()} rps` : '—'}</td>
              </tr>
              {(client.scope?.targets ?? []).map((t) => (
                <tr key={t}>
                  <td>Target</td>
                  <td>{t}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Contacts</h2>
          <table className="campaign-table">
            <tbody>
              {client.contacts.map((c) => (
                <tr key={c.email}>
                  <td>{c.name}</td>
                  <td>{c.email}</td>
                  <td className="hint">{c.role ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: '.75rem' }}>
            {campaigns.length} campaign(s) · {unmet} finalized
          </p>
        </section>
      </div>

      <h2>Campaigns</h2>
      {campaigns.length === 0 ? (
        <p className="hint">
          No campaign for this client yet. Start one from <a href="/capacity">Capacity</a>.
        </p>
      ) : (
        <table className="campaign-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Mode</th>
              <th>State</th>
              <th>Proofs</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => {
              const doc = c.drsDocument!;
              const rev =
                doc.revisions.find((r) => r.number === doc.currentRevision) ?? doc.revisions[0];
              const plan = (rev?.plan ?? {}) as { mode?: string };
              return (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    <div className="hint">{c.target}</div>
                  </td>
                  <td>{plan.mode ?? '—'}</td>
                  <td>{rev?.state ?? '—'}</td>
                  <td>{(rev?.proofs ?? []).length}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => navigate(`/drs`)}>
                      Open
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

import { LineIcon } from './interface-kit.js';
