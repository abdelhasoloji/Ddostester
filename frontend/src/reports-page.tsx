import { useEffect, useState } from 'react';
import { api, complianceUrl, runsCsvUrl, reportUrl, compareUrl } from './api.js';
import type { CampaignRun } from './api.js';
import { useApp } from './context.js';
import { PageHead } from './pages.js';

/** Authenticated retained-run exports and conservative before/after reports. */
export function ReportsPage() {
  const app = useApp();
  const [runs, setRuns] = useState<CampaignRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [sharing, setSharing] = useState(false);
  const [selectedA, setSelectedA] = useState('');
  const [selectedB, setSelectedB] = useState('');
  useEffect(() => {
    let active = true;
    api
      .listRuns()
      .then((data) => {
        if (active)
          setRuns(
            [...data].sort((a, b) =>
              (a.generator.finishedAt ?? '').localeCompare(b.generator.finishedAt ?? ''),
            ),
          );
      })
      .catch((reason) => {
        if (active) setLoadError((reason as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const a = selectedA || runs[0]?.runId || '';
  const b = selectedB || runs[runs.length - 1]?.runId || '';
  const label = (run: CampaignRun) =>
    `${app.campaigns.find((c) => c.id === run.campaignId)?.name ?? run.campaignId} · ${run.generator.finishedAt ?? 'timestamp unavailable'} · ${run.status}`;
  const share = async () => {
    setSharing(true);
    setMessage('');
    setError('');
    try {
      const result = await api.createShare(60);
      if (result.authRequired && !result.token)
        throw new Error('No read-only share token returned.');
      const url = new URL(complianceUrl(), window.location.origin);
      if (result.token) url.searchParams.set('token', result.token);
      await navigator.clipboard.writeText(url.toString());
      setMessage('Read-only report link copied.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSharing(false);
    }
  };
  return (
    <>
      <PageHead
        title="Results"
        sub="Retained runs, compliance exports and before/after comparisons."
      />
      {(error || loadError) && (
        <p role="alert" className="error">
          {error || loadError}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="card">
        <h2>Aggregated compliance</h2>
        <p>Exports contain the retained observations and their measurement limits.</p>
        <div className="row">
          <a className="btn" href={complianceUrl()} target="_blank" rel="noreferrer">
            Open compliance report
          </a>
          <a className="btn" href={runsCsvUrl()}>
            Export runs CSV
          </a>
          {app.userMode === 'team' ? (
            <button className="btn" disabled={sharing} onClick={() => void share()}>
              {sharing ? 'Creating link…' : 'Copy share link'}
            </button>
          ) : (
            <span className="hint">Sharing is disabled in single-user mode.</span>
          )}
        </div>
      </section>
      <section className="card">
        <h2>Before / after comparison</h2>
        <p>
          Comparisons remain inconclusive when source, configuration or measurement quality differs.
        </p>
        {loading ? (
          <p role="status">Loading retained runs…</p>
        ) : loadError ? (
          <p className="hint">Retained run history unavailable.</p>
        ) : runs.length < 2 ? (
          <p className="hint">Two retained runs are needed for comparison.</p>
        ) : (
          <>
            <label htmlFor="report-before">Run A (before)</label>
            <select
              id="report-before"
              value={a}
              onChange={(event) => setSelectedA(event.target.value)}
            >
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {label(run)}
                </option>
              ))}
            </select>
            <label htmlFor="report-after">Run B (after)</label>
            <select
              id="report-after"
              value={b}
              onChange={(event) => setSelectedB(event.target.value)}
            >
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {label(run)}
                </option>
              ))}
            </select>
            {a !== b ? (
              <a className="btn" href={compareUrl(a, b)} target="_blank" rel="noreferrer">
                Compare selected runs
              </a>
            ) : (
              <p className="hint">Choose two different runs.</p>
            )}
          </>
        )}
      </section>
      <section className="card">
        <h2>Retained run reports</h2>
        {!loading && !loadError && runs.length === 0 && (
          <p className="hint">No retained runs yet.</p>
        )}
        <ul>
          {[...runs].reverse().map((run) => (
            <li key={run.runId}>
              <a href={reportUrl(run.runId)} target="_blank" rel="noreferrer">
                {label(run)}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
