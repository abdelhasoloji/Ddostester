import { useEffect, useState } from 'react';
import { useApp } from './context.js';
import { api, complianceUrl, runsCsvUrl, compareUrl } from './api.js';
import type { Campaign, RunComparison } from './api.js';
import { PageHead, GrafanaLink, SuitesSection } from './pages.js';

export function ReportsPage() {
  const app = useApp();
  const withRun = app.campaigns.filter((c) => c.runId);
  return (
    <>
      <PageHead
        title="Results"
        sub="The cross-campaign view: assessment-suite verdicts, before/after comparisons (tune & replay) and aggregated DORA / NIS2 compliance. Per-run detail lives on the Campaigns list — filter Done and expand a row."
      />
      <GrafanaLink plane="resilience" label="Resilience trends in Grafana" />
      <SuitesSection />
      {withRun.length >= 2 && <CompareSection campaigns={withRun} />}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Aggregated compliance</h2>
        <p className="hint">
          Summary of every executed campaign, aligned with operational resilience (DORA) and risk
          management (NIS2) requirements.
        </p>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <a className="btn btn-primary" href={complianceUrl()} target="_blank" rel="noreferrer">
            Open compliance report ↗
          </a>
          <a className="btn btn-ghost" href={runsCsvUrl()} target="_blank" rel="noreferrer">
            Export runs CSV ↓
          </a>
          <ShareLinkButton />
        </div>
        {withRun.length === 0 && (
          <p className="hint" style={{ marginTop: '.6rem' }}>
            No campaign has run yet — the compliance rollup fills in as runs complete.
          </p>
        )}
      </div>
    </>
  );
}

/** Mints a short-lived read-only token and copies a shareable compliance-report link. */
function ShareLinkButton() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const share = async () => {
    setBusy(true);
    try {
      const res = await api.createShare(24 * 60); // 24h read-only link
      const base = `${window.location.origin}/api/reports/compliance`;
      const url = res.token ? `${base}?token=${encodeURIComponent(res.token)}` : base;
      await navigator.clipboard.writeText(url);
      app.push(
        'success',
        res.token
          ? `Read-only link copied (expires in 24h).`
          : `Link copied (auth is disabled — no token needed).`,
      );
    } catch {
      app.push('error', 'Could not create a share link.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-ghost" onClick={share} disabled={busy}>
      {busy ? <span className="spin" /> : null}Copy share link 🔗
    </button>
  );
}

/** Before / after comparison: pick two runs (same target ideally) and open the delta report. */
/** Format a metric value with its unit, or an em dash when absent. */
function fmtMetric(v: number | null, unit?: string): string {
  return v == null ? '—' : `${v}${unit ?? ''}`;
}

function CompareSection({ campaigns }: { campaigns: Campaign[] }) {
  const [a, setA] = useState(campaigns[0]?.id ?? '');
  const [b, setB] = useState(campaigns[1]?.id ?? '');
  const [cmp, setCmp] = useState<RunComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const ca = campaigns.find((c) => c.id === a);
  const cb = campaigns.find((c) => c.id === b);
  const opt = (c: Campaign) => `${c.name}${c.wrs ? ` — WRS ${c.wrs.wrs}` : ''}`;
  const runA = ca?.runId;
  const runB = cb?.runId;
  const canCompare = !!runA && !!runB && a !== b;

  useEffect(() => {
    if (!canCompare || !runA || !runB) {
      setCmp(null);
      return;
    }
    let live = true;
    setLoading(true);
    api
      .compareRuns(runA, runB)
      .then((r) => live && setCmp(r))
      .catch(() => live && setCmp(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [runA, runB, canCompare]);

  const verdictLabel: Record<RunComparison['verdict'], string> = {
    improved: '▲ Improved',
    regressed: '▼ Regressed',
    unchanged: '± Unchanged',
  };

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2>Mitigation proof — before / after</h2>
      <p className="hint">
        Compare two runs of the same target (typically before and after a protection change) — did
        the resilience actually improve? WRS, availability, latency, origin 5xx and edge absorption,
        with a verdict.
      </p>
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={a} onChange={(e) => setA(e.target.value)} aria-label="Run A (before)">
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              A · {opt(c)}
            </option>
          ))}
        </select>
        <span aria-hidden="true">→</span>
        <select value={b} onChange={(e) => setB(e.target.value)} aria-label="Run B (after)">
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              B · {opt(c)}
            </option>
          ))}
        </select>
        {canCompare && (
          <a
            className="btn btn-sm btn-ghost"
            href={compareUrl(runA!, runB!)}
            target="_blank"
            rel="noreferrer"
          >
            Full report ↗
          </a>
        )}
      </div>
      {a !== '' && a === b && <p className="hint">Pick two different runs to compare.</p>}
      {loading && (
        <p className="hint" style={{ marginTop: '1rem' }}>
          <span className="spin" /> Comparing…
        </p>
      )}
      {cmp && !loading && (
        <div className={`mproof mp-${cmp.verdict}`} style={{ marginTop: '1rem' }}>
          <div className="mproof-head">
            <span className={`mproof-badge mp-${cmp.verdict}`}>{verdictLabel[cmp.verdict]}</span>
            <span className="mproof-headline">{cmp.headline}</span>
          </div>
          <div className="mproof-scroll">
            <table className="mproof-metrics">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Before</th>
                  <th>After</th>
                  <th>Δ</th>
                </tr>
              </thead>
              <tbody>
                {cmp.metrics.map((m) => (
                  <tr key={m.key}>
                    <th scope="row">{m.label}</th>
                    <td>{fmtMetric(m.before, m.unit)}</td>
                    <td>{fmtMetric(m.after, m.unit)}</td>
                    <td
                      className={
                        m.improved === true ? 'good' : m.improved === false ? 'bad' : 'muted'
                      }
                    >
                      {m.delta == null
                        ? '—'
                        : `${m.delta > 0 ? '▲ +' : m.delta < 0 ? '▼ ' : '± '}${m.delta}${m.unit ?? ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cmp.remainingRemediations.length > 0 && (
            <div className="mproof-rem">
              <b>Still to address on the “after” run:</b>
              <ul>
                {cmp.remainingRemediations.map((r) => (
                  <li key={r.id}>
                    <span className={`sev sev-${r.severity}`}>{r.severity}</span> {r.remediation}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
