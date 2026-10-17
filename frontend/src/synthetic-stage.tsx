import type { SyntheticView } from './api.js';
import { HelpTip } from './help-tip.js';

const labels: Record<string, string> = {
  DRAFT: 'Ready for review',
  RUNNING: 'In progress',
  PAUSED: 'Paused',
  STOPPING: 'Stopping',
  COMPLETED: 'Completed',
  FAILED: 'Interrupted',
  CANCELLED: 'Stopped',
};
export function SyntheticStage({ data, now }: { data: SyntheticView; now: number }) {
  const j = data.campaign.syntheticJourney!;
  const claimed = data.runs.findIndex((r) => r?.status === 'CLAIMED');
  const pending = j.steps.findIndex(
    (s, i) => !s.result && !['COMPLETED', 'FAILED'].includes(data.runs[i]?.status ?? ''),
  );
  const index = claimed >= 0 ? claimed : pending;
  const step = j.steps[index];
  const waiting = j.state === 'RUNNING' && !!j.nextAt && j.nextAt > now;
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.state);
  const title = terminal
    ? j.state === 'COMPLETED'
      ? 'Execution complete'
      : 'Execution ended'
    : j.state === 'DRAFT'
      ? 'Your campaign is ready for review'
      : claimed >= 0
        ? (step?.name ?? step?.scenarioId)
        : j.state === 'PAUSED'
          ? 'Next scenario on hold'
          : j.state === 'STOPPING'
            ? 'Finishing the bounded scenario'
            : waiting
              ? 'Recovery interval'
              : 'Waiting for the next observation';
  const elapsed = j.startedAt
    ? Math.max(
        0,
        Math.floor(
          ((j.finishedAt ? Date.parse(j.finishedAt) : now) - Date.parse(j.startedAt)) / 1000,
        ),
      )
    : null;
  // Only settled, actual runner observations qualify for these summaries.
  const observations = data.runs.flatMap((r, i) =>
    r?.status === 'COMPLETED' &&
    j.steps[i]?.execution !== 'SIMULATION' &&
    j.steps[i]?.result?.kind !== 'NOT_EVALUATED' &&
    r.verdict
      ? [{ run: r, step: j.steps[i], index: i }]
      : [],
  );
  const latest = observations.at(-1);
  const bytes = observations.filter(
    (o) => !o.run.verdict?.connections && o.run.verdict?.target?.avgBps !== undefined,
  );
  const peak = bytes.length ? Math.max(...bytes.map((o) => o.run.verdict!.target!.avgBps!)) : null;
  const value = latest?.run.verdict?.connections
    ? `${latest.run.verdict.connections.accepted ?? '—'}`
    : latest?.run.verdict?.target?.avgBps !== undefined
      ? (latest.run.verdict.target.avgBps / 1e6).toFixed(2)
      : '—';
  return (
    <>
      <div className="synthetic-stage" data-state={j.state}>
        <div className="synthetic-stage-top">
          <span className="synthetic-eyebrow">
            RUN THEATER · DRS {j.definition.reference.targetLevel} OBJECTIVE
          </span>
          <span className="synthetic-status">
            {j.state === 'RUNNING' && <span className="campaign-live-indicator" />}
            {labels[j.state]}
          </span>
        </div>
        <h3>{title}</h3>
        <p>
          {claimed >= 0 && step
            ? `Scenario ${index + 1} of ${j.steps.length} · ${step.execution === 'SIMULATION' ? 'Simulation · no traffic' : 'Lab measurement · partial shape'}`
            : terminal
              ? 'Results are preserved for each scenario.'
              : `${j.definition.labTarget} · ${j.definition.reference.intervalSec}s between scenarios`}
        </p>
        {waiting && (
          <span className="synthetic-countdown">
            Next in {Math.max(0, Math.ceil((j.nextAt! - now) / 1000))}s
          </span>
        )}
      </div>
      <div className="synthetic-metrics" aria-label="Campaign observations">
        <div>
          <span>Elapsed</span>
          <strong>
            {elapsed === null || !Number.isFinite(elapsed)
              ? '—'
              : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
          </strong>
          <small>Campaign wall time</small>
        </div>
        <div>
          <span>Latest observation</span>
          <strong>
            {value}
            <small>
              {latest?.run.verdict?.connections
                ? 'connections accepted'
                : latest?.run.verdict?.target?.avgBps !== undefined
                  ? 'Mbit/s received'
                  : ''}
            </small>
          </strong>
          <small>
            {latest
              ? `Scenario ${latest.index + 1} · ${latest.run.verdict?.connections ? 'accepted connections' : 'settled average'}`
              : 'No settled measurement yet'}
          </small>
        </div>
        <div>
          <span>
            Highest scenario average{' '}
            <HelpTip label="Received load meaning">
              Highest received average among completed packet scenarios, not an instantaneous peak.
              Connection counts and simulations are excluded. No qualified DRS score is derived.
            </HelpTip>
          </span>
          <strong>
            {peak === null ? '—' : (peak / 1e6).toFixed(2)}
            <small>{peak === null ? '' : 'Mbit/s received'}</small>
          </strong>
          <small>Measured laboratory traffic only</small>
        </div>
      </div>
      {bytes.length > 0 && (
        <details className="synthetic-details synthetic-observations">
          <summary>
            Received load by scenario <span>{bytes.length} observations</span>
          </summary>
          <p className="hint">Settled scenario averages · not a live time series</p>
          <ul aria-label="Measured received load">
            {bytes.map((o) => (
              <li key={o.run.id}>
                <span>
                  {o.index + 1}. {o.step?.name ?? o.run.scenario}
                </span>
                <span className="synthetic-bar" aria-hidden="true">
                  <i
                    style={{
                      width: `${peak && peak > 0 ? (o.run.verdict!.target!.avgBps! / peak) * 100 : 0}%`,
                    }}
                  />
                </span>
                <b>{(o.run.verdict!.target!.avgBps! / 1e6).toFixed(2)} Mbit/s</b>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
