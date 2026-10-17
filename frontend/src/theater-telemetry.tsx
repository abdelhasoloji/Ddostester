import { useEffect, useState } from 'react';
import { api, getGrafanaBase, grafanaDashUrl, type Campaign, type MetricsRange } from './api.js';
import { PromChart } from './PromChart.js';
import { HelpTip } from './help-tip.js';
import './campaign-manager.css';
const panels = [
  ['drs_score', 'DRS assessment'],
  ['drs_coverage', 'Vector coverage'],
  ['drs_agents', 'Fleet participation'],
] as const;
export function TheaterTelemetry({ campaign }: { campaign: Campaign }) {
  const revision = campaign.drsDocument?.revisions.find(
    (r) => r.number === campaign.drsDocument?.currentRevision,
  );
  const [data, setData] = useState<Record<string, MetricsRange>>({}),
    [error, setError] = useState('');
  useEffect(() => {
    setData({});
    setError('');
    if (!revision?.id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const results = await Promise.allSettled(
        panels.map(
          async ([key]) =>
            [
              key,
              await api.metricsRange(key, {
                campaignId: campaign.id,
                revisionId: revision.id,
                minutes: 60,
                step: 15,
              }),
            ] as const,
        ),
      );
      if (!live) return;
      const next: Record<string, MetricsRange> = {};
      for (const r of results) if (r.status === 'fulfilled') next[r.value[0]] = r.value[1];
      setData(next);
      setError(
        results.some((r) => r.status === 'rejected') ? 'Some observations are unavailable' : '',
      );
      if (!revision.finalizedAt) timer = setTimeout(() => void poll(), 15000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [campaign.id, revision?.id, revision?.finalizedAt]);
  if (!revision) return null;
  const base = getGrafanaBase();
  return (
    <section aria-label="Campaign observability">
      <h2>
        <span
          className={campaign.status === 'RUNNING' ? 'campaign-live-indicator' : ''}
          aria-hidden="true"
        />
        Campaign observability{' '}
        <HelpTip label="Grafana observations">
          These native panels use the same scoped Prometheus metrics as the Grafana DRS dashboard.
          Missing data remains unknown. Fleet reports do not prove traffic received at the
          protection. Inspect mode and report finalization before interpreting a score.
        </HelpTip>
      </h2>
      <p className="hint">
        {String(revision.plan.mode)} ·{' '}
        {revision.finalizedAt ? 'Finalized report' : 'Provisional observation'}
      </p>
      {base && (
        <a
          href={grafanaDashUrl(base, 'drs', { campaignId: campaign.id, revisionId: revision.id })}
          target="_blank"
          rel="noreferrer"
        >
          Open full Grafana dashboard ↗
        </a>
      )}
      {error && <p role="status">{error}</p>}
      <div className="campaign-telemetry">
        {panels.map(([key, title]) => {
          const range = data[key];
          const observed = range?.source === 'ok' && range.series.some((s) => s.points.length);
          return (
            <article className="card" key={key}>
              <h3>{title}</h3>
              {observed ? (
                <PromChart range={range} />
              ) : (
                <p role="status">
                  {range ? 'No qualified observation available' : 'Loading observations…'}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
