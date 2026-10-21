import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type DrsCompareView } from './api.js';
import { LineIcon } from './interface-kit.js';

const list = (items: { vectorId: string; dimension: string }[]) =>
  items.length === 0 ? 'none' : items.map((g) => `${g.vectorId} ${g.dimension}`).join(', ');

/**
 * Two assessments of the same intent, side by side. The useful sentence after a protection
 * change is not "the score moved" but which archived requirement is now met, which is still
 * not, and which regressed.
 */
export function ComparePage() {
  const { id = '', with: withId = '' } = useParams();
  const [view, setView] = useState<DrsCompareView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .drsCompare(id, withId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, withId]);

  if (error) return <p role="alert">{error}</p>;
  if (!view) return <p className="hint">Loading comparison…</p>;

  const resolved = view.deltas.gapsResolved.length;
  const remaining = view.deltas.gapsRemaining.length;
  const regressed = view.deltas.gapsRegressed.length;

  return (
    <>
      <div className="page-head page-head--icon">
        <div>
          <h1>Comparison</h1>
          <p className="hint">
            {view.a.name} → {view.b.name} · revisions {view.a.revision} and {view.b.revision}
          </p>
        </div>
        <span className="page-head-icon" aria-hidden="true">
          <LineIcon name="results" />
        </span>
      </div>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <p style={{ margin: 0 }}>
          {resolved === 0 && regressed === 0 && remaining > 0 ? (
            <>Nothing moved: {remaining} requirement(s) are still unmet and none regressed.</>
          ) : (
            <>
              {resolved} requirement(s) resolved, {remaining} still unmet
              {regressed > 0 ? `, ${regressed} regressed` : ''}.
            </>
          )}{' '}
          The verdict went from <b>{view.a.status}</b> to <b>{view.b.status}</b>
          {view.deltas.levelChange !== 0
            ? ` (level ${view.deltas.levelChange > 0 ? '+' : ''}${view.deltas.levelChange})`
            : ''}
          .
        </p>
      </section>

      <table className="campaign-table">
        <thead>
          <tr>
            <th />
            <th>{view.a.name}</th>
            <th>{view.b.name}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Verdict</td>
            <td>{view.a.status}</td>
            <td>{view.b.status}</td>
          </tr>
          <tr>
            <td>Terminal level</td>
            <td>{view.a.terminalLevel ?? '—'}</td>
            <td>{view.b.terminalLevel ?? '—'}</td>
          </tr>
          <tr>
            <td>Sealed proofs</td>
            <td>{view.a.proofs}</td>
            <td>{view.b.proofs}</td>
          </tr>
          <tr>
            <td>Finalized</td>
            <td>{view.a.finalizedAt ? new Date(view.a.finalizedAt).toLocaleString() : '—'}</td>
            <td>{view.b.finalizedAt ? new Date(view.b.finalizedAt).toLocaleString() : '—'}</td>
          </tr>
          <tr>
            <td>Requirements resolved</td>
            <td colSpan={2}>{list(view.deltas.gapsResolved)}</td>
          </tr>
          <tr>
            <td>Still unmet</td>
            <td colSpan={2}>{list(view.deltas.gapsRemaining)}</td>
          </tr>
          <tr>
            <td>Regressed</td>
            <td colSpan={2}>{list(view.deltas.gapsRegressed)}</td>
          </tr>
        </tbody>
      </table>

      <p className="row" style={{ marginTop: '1rem' }}>
        <a className="btn btn-sm" href={`/assessments/${encodeURIComponent(id)}`}>
          Open the first assessment
        </a>
        <a className="btn btn-sm" href={`/assessments/${encodeURIComponent(withId)}`}>
          Open the second
        </a>
      </p>
    </>
  );
}
