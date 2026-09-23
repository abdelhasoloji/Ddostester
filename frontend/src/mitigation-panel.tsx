import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { MitigationValidation, MitigationVerdict } from './api.js';

/**
 * Read-only mitigation validation (TTD/TTM tier). Fetches a run's measured
 * detection/mitigation timing correlated with its load timeline and shows how
 * the edge behaved before detection vs after mitigation. Displays nothing that
 * generates load — pure measurement.
 */
const VERDICT: Record<MitigationVerdict, { cls: string; label: string }> = {
  mitigated: { cls: 'mv-ok', label: '✓ mitigated' },
  partial: { cls: 'mv-warn', label: '~ partial' },
  'not-exercised': { cls: 'mv-none', label: '○ not exercised' },
  'not-engaged': { cls: 'mv-bad', label: '⃠ not engaged' },
  'no-measurement': { cls: 'mv-none', label: 'no measurement' },
  'insufficient-data': { cls: 'mv-none', label: 'insufficient data' },
};

const pct = (r?: number): string => (r == null ? '—' : `${Math.round(r * 100)}%`);
const signed = (n?: number, unit = ''): string =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n}${unit}`;

export function MitigationPanel({ runId }: { runId: string }) {
  const [v, setV] = useState<MitigationValidation | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setV(null);
    setFailed(false);
    api
      .runMitigation(runId)
      .then((r) => live && setV(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [runId]);

  if (failed || !v) return null;
  const badge = VERDICT[v.verdict];
  const hasWindows = v.before != null && v.after != null;

  return (
    <div className="mitigation-panel">
      <div className="mv-head">
        <span className="mv-title">Mitigation validation</span>
        <span className={`mv-badge ${badge.cls}`}>{badge.label}</span>
        {v.source && <span className="hint">· {v.source}</span>}
        {v.theoretical && (
          <span
            className="mv-theoretical"
            title="WRS delta is model-based (measured TTD/TTM), not observed absorption"
          >
            theoretical Δ
          </span>
        )}
      </div>

      {(v.ttdSec != null || v.ttmSec != null) && (
        <div className="mv-timings">
          <span>
            TTD <strong>{v.ttdSec ?? '—'}s</strong>
          </span>
          <span>
            TTM <strong>{v.ttmSec ?? '—'}s</strong>
          </span>
        </div>
      )}

      {hasWindows && (
        <table className="mv-table">
          <thead>
            <tr>
              <th />
              <th>Before</th>
              <th>After</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Edge absorbed</td>
              <td>{pct(v.before!.absorbedRatio)}</td>
              <td>{pct(v.after!.absorbedRatio)}</td>
              <td>
                {v.absorbedDelta == null ? '—' : signed(Math.round(v.absorbedDelta * 100), '%')}
              </td>
            </tr>
            <tr>
              <td>Legit availability</td>
              <td>{v.before!.availabilityPct}%</td>
              <td>{v.after!.availabilityPct}%</td>
              <td>{signed(v.availabilityDelta, ' pts')}</td>
            </tr>
            <tr>
              <td>WRS</td>
              <td>{v.wrsBefore ?? '—'}</td>
              <td>{v.wrsAfter ?? '—'}</td>
              <td className={v.wrsDelta != null && v.wrsDelta >= 0 ? 'mv-up' : 'mv-down'}>
                {signed(v.wrsDelta)}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <p className="hint mv-note">{v.note}</p>
    </div>
  );
}
