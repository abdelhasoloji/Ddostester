import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { Card, Chip, EmptyState, ModeChip, verdictTone } from './design-system.js';

type Report = Awaited<ReturnType<typeof api.drsReports>>['reports'][number];

/**
 * The deliverable index. A client asks for "the report"; this is where it lives, with the three
 * forms it takes — readable page, machine data, and the sealed bundle.
 */
export function ReportsLibraryPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [client, setClient] = useState('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .drsReports()
      .then((r) => {
        if (!cancelled) setReports(r.reports);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clients = useMemo(
    () => [...new Set(reports.map((r) => r.client).filter((c): c is string => Boolean(c)))].sort(),
    [reports],
  );
  const visible = reports.filter((r) => client === 'all' || r.client === client);

  if (error) return <p role="alert">{error}</p>;

  return (
    <>
      <div className="page-head page-head--icon">
        <div>
          <h1>Reports</h1>
          <p className="hint">
            One row per finalised revision. The PDF and the bundle are the client deliverable; the
            JSON is the same assessment for machines.
          </p>
        </div>
      </div>

      {reports.length === 0 ? (
        <EmptyState
          title="No report yet"
          action={
            <a className="btn btn-sm btn-primary" href="/campaigns/new">
              Start a campaign
            </a>
          }
        >
          A report appears once a campaign reaches a verdict, measured or synthetic.
        </EmptyState>
      ) : (
        <>
          <div className="filters-row">
            <label>
              Client
              <select value={client} onChange={(e) => setClient(e.target.value)}>
                <option value="all">All clients</option>
                {clients.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint" style={{ margin: 0 }}>
              {visible.length} of {reports.length} reports
            </span>
          </div>

          <table className="campaign-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Campaign</th>
                <th>Mode</th>
                <th>Verdict</th>
                <th>Date</th>
                <th>Deliverables</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={`${r.campaignId}-${r.revision}`}>
                  <td>{r.client ?? <span className="hint">unregistered</span>}</td>
                  <td>
                    <a href={`/assessments/${r.campaignId}`}>
                      <b>{r.campaignName}</b>
                    </a>
                    <div className="hint">{r.target}</div>
                  </td>
                  <td>
                    <ModeChip mode={r.mode} />
                  </td>
                  <td>
                    <Chip tone={r.synthetic ? 'plain' : verdictTone(r.status)}>{r.status}</Chip>
                  </td>
                  <td className="hint">{new Date(r.finalizedAt).toLocaleString()}</td>
                  <td>
                    <a
                      className="btn btn-sm"
                      href={`/api/campaigns/${r.campaignId}/drs/report.html`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Report
                    </a>{' '}
                    <a
                      className="btn btn-sm"
                      href={`/api/campaigns/${r.campaignId}/drs/report.json`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      JSON
                    </a>{' '}
                    <a className="btn btn-sm" href={`/api/campaigns/${r.campaignId}/drs/bundle`}>
                      Bundle
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>What the client receives</h2>
          <Card>
            <p className="hint" style={{ margin: 0 }}>
              A readable report with the verdict, the archived requirements the fleet did not reach
              and the evidence hashes; a machine-readable JSON; and a bundle that adds a manifest
              stating the scope, the envelope and the proof hashes. None of them claims a
              certification.
            </p>
          </Card>
        </>
      )}
    </>
  );
}
