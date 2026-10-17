import { AssessmentComparison } from './assessment-comparison.js';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Campaign } from './api.js';
import { HelpTip } from './help-tip.js';
const clients = [
  { id: 'bank-cz', name: 'bank.cz' },
  { id: 'enisa-preprod', name: 'ENISA preproduction' },
  { id: 'test-vps', name: 'Test VPS' },
];
export function ClientAssessmentArchive() {
  const [campaigns, setCampaigns] = useState<Campaign[]>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setCampaigns(undefined);
    setError('');
    void api
      .listCampaigns()
      .then((data) => {
        if (live) setCampaigns(data);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [reload]);
  const [clientId, setClientId] = useState('');
  const assessments = (campaigns ?? [])
    .filter(
      (c) =>
        c.drsMode === 'engine-validation' &&
        clients.some((client) => client.id === c.clientWorkspace?.id) &&
        (!clientId || c.clientWorkspace?.id === clientId),
    )
    .sort(
      (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id),
    );
  return (
    <section className="card client-assessment-archive" aria-label="Client assessment archive">
      <h2>
        Client assessments{' '}
        <HelpTip label="Assessment archive">
          Saved client-bound simulations, including archived campaigns. Physical run reports remain
          separate below.
        </HelpTip>
      </h2>
      <button
        className="btn btn-sm"
        disabled={!campaigns && !error}
        onClick={() => setReload((n) => n + 1)}
      >
        Refresh assessments
      </button>
      {error && <p role="alert">Assessment archive unavailable: {error}</p>}
      {!campaigns && !error && <p role="status">Loading assessments…</p>}
      <label>
        Client
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {campaigns &&
        (assessments.length ? (
          <div className="assessment-archive-scroll">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {assessments.map((c) => {
                  const rev = c.drsDocument?.revisions.find(
                    (r) => r.number === c.drsDocument?.currentRevision,
                  );
                  return (
                    <tr key={c.id}>
                      <td>
                        {c.clientWorkspace!.profile.name}
                        <small className="archive-mobile-meta">
                          {c.createdAt ? new Date(c.createdAt).toLocaleString() : '—'} · simulation
                        </small>
                      </td>
                      <td>{c.createdAt ? new Date(c.createdAt).toLocaleString() : '—'}</td>
                      <td>
                        {rev?.finalizedAt ? 'Report ready' : (rev?.state ?? c.status)}
                        {c.archived ? ' · archived' : ''}
                      </td>
                      <td>Simulation</td>
                      <td>
                        <Link
                          to={`/clients/${encodeURIComponent(c.clientWorkspace!.id)}?prototype=${encodeURIComponent(c.id)}`}
                        >
                          {rev?.finalizedAt
                            ? 'Open report'
                            : c.archived
                              ? 'Open campaign'
                              : 'Resume campaign'}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hint">No client assessments yet.</p>
        ))}
      {campaigns && clientId && (
        <AssessmentComparison key={clientId} clientId={clientId} campaigns={assessments} />
      )}
    </section>
  );
}
