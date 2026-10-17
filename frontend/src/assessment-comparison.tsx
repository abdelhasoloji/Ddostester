import { useEffect, useState } from 'react';
import { api, type Campaign, type DrsReportView } from './api.js';
import { HelpTip } from './help-tip.js';
import { comparableReports } from './assessment-comparison-model.js';
export function AssessmentComparison({
  clientId,
  campaigns,
}: {
  clientId: string;
  campaigns: Campaign[];
}) {
  const [a, setA] = useState(''),
    [b, setB] = useState('');
  const [result, setResult] = useState<{
    pair: string;
    reports: [DrsReportView, DrsReportView];
    comparison: ReturnType<typeof comparableReports>;
  }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const finalized = campaigns.filter(
    (c) =>
      c.drsMode === 'engine-validation' &&
      c.clientWorkspace?.id === clientId &&
      c.drsDocument?.revisions.some(
        (r) => r.number === c.drsDocument?.currentRevision && r.finalizedAt,
      ),
  );
  const left = finalized.find((c) => c.id === a),
    right = finalized.find((c) => c.id === b);
  const pair = a + '\0' + b;
  useEffect(() => {
    let live = true;
    setResult(undefined);
    setError('');
    setLoading(false);
    if (!left || !right) return;
    if (left.id === right.id) {
      setError('Choose two different assessments.');
      return;
    }
    setLoading(true);
    const revision = (c: Campaign) => c.drsDocument!.currentRevision;
    void Promise.all([
      api.drsReport(left.id, revision(left)),
      api.drsReport(right.id, revision(right)),
    ])
      .then((reports) => {
        const comparison = comparableReports(clientId, [left, right], reports);
        if (live) setResult({ pair: left.id + '\0' + right.id, reports, comparison });
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [left, right, clientId]);
  const visible = result?.pair === pair ? result : undefined;
  return (
    <details className="assessment-comparison">
      <summary>
        Compare assessments{' '}
        <HelpTip label="Assessment comparison">
          Two finalized simulations with the same client scope revision, reference and frozen plan.
          A partial result cannot establish score improvement.
        </HelpTip>
      </summary>
      {finalized.length < 2 ? (
        <p className="hint">Two finalized assessments required.</p>
      ) : (
        <>
          <div className="assessment-comparison-selectors">
            {(['A', 'B'] as const).map((label) => (
              <label key={label}>
                Assessment {label}
                <select
                  value={label === 'A' ? a : b}
                  onChange={(e) => (label === 'A' ? setA : setB)(e.target.value)}
                >
                  <option value="">Choose an assessment</option>
                  {finalized.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      {i + 1} · {c.createdAt ? new Date(c.createdAt).toLocaleString() : c.name}
                      {c.archived ? ' · archived' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {loading && <p role="status">Loading comparison…</p>}
          {error && <p role="alert">{error}</p>}
          {visible && (
            <section aria-label="Assessment comparison result">
              <span className="workbench-tag">Simulation only</span>
              <p>
                A: {visible.reports[0].assessment.status} · B:{' '}
                {visible.reports[1].assessment.status}
              </p>
              <p>
                Score change:{' '}
                {visible.comparison.delta === null
                  ? 'Indeterminate'
                  : Number(visible.comparison.delta.toFixed(6))}
              </p>
              <table>
                <caption>Level outcomes · A → B</caption>
                <thead>
                  <tr>
                    <th>Level</th>
                    <th>A</th>
                    <th>B</th>
                    <th>Unknown A / B</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.comparison.levels.map((l) => (
                    <tr key={l.level}>
                      <td>{l.level}</td>
                      <td>{l.a?.outcome ?? 'Not evaluated'}</td>
                      <td>{l.b?.outcome ?? 'Not evaluated'}</td>
                      <td>
                        {l.a?.inconclusive ?? '—'} / {l.b?.inconclusive ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </details>
  );
}
