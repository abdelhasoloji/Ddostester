import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type Campaign,
  type DrsCapacityView,
  type DrsClientView,
  type DrsReportView,
} from './api.js';
import { useApp } from './context.js';
import {
  Bar,
  Card,
  Chip,
  EmptyState,
  Kpi,
  ModeChip,
  StateChip,
  verdictTone,
} from './design-system.js';

interface Row {
  campaign: Campaign;
  state: string;
  mode: string;
  level: number;
  proofs: number;
  finalizedAt: string | null;
  verdict: string | null;
}

const stateOf = (c: Campaign): Row | null => {
  const doc = c.drsDocument;
  if (!doc) return null;
  const rev = doc.revisions.find((r) => r.number === doc.currentRevision) ?? doc.revisions[0];
  if (!rev) return null;
  const plan = (rev.plan ?? {}) as { mode?: string; maxLevel?: number };
  return {
    campaign: c,
    state: rev.state,
    mode: plan.mode ?? '—',
    level: typeof plan.maxLevel === 'number' ? plan.maxLevel : 1,
    proofs: (rev.proofs ?? []).length,
    finalizedAt: rev.finalizedAt ?? null,
    verdict: null,
  };
};

/**
 * The question the operator arrives with: is this protected, what is running, and what needs a
 * decision. Everything below answers one of those three and nothing else.
 */
export function OverviewPage() {
  const app = useApp();
  const [clients, setClients] = useState<DrsClientView[]>([]);
  const [capacity, setCapacity] = useState<DrsCapacityView | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, DrsReportView>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () => app.campaigns.map(stateOf).filter((r): r is Row => r !== null),
    [app.campaigns],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.drsClients(), api.drsCapacity()])
      .then(([c, k]) => {
        if (cancelled) return;
        setClients(c.clients);
        setCapacity(k);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [app.campaigns]);

  // Verdicts for the few finalised campaigns only: the overview must stay a summary.
  useEffect(() => {
    const finalised = rows.filter((r) => r.finalizedAt && !verdicts[r.campaign.id]).slice(0, 12);
    if (finalised.length === 0) return;
    let cancelled = false;
    void Promise.all(
      finalised.map(async (r) => {
        try {
          const report = await api.drsCampaignReport(r.campaign.id);
          if (!cancelled) setVerdicts((prev) => ({ ...prev, [r.campaign.id]: report }));
        } catch {
          /* a report that cannot be read is simply absent */
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [rows, verdicts]);

  // A campaign is running only while it is between the plan and its terminal state. Treating
  // anything not frozen as running showed a stop button on finished campaigns.
  const RUNNING_STATES = new Set([
    'CAPACITY_CHECK',
    'BASELINE',
    'LEVEL_EXECUTION',
    'RECOVERY',
    'EVIDENCE_VALIDATION',
    'LEVEL_CALCULATION',
  ]);
  const running = rows.filter((r) => !r.finalizedAt && RUNNING_STATES.has(r.state));

  const coverage = useMemo(() => {
    const byLevel = new Map<number, { met: number; total: number }>();
    for (const r of rows) {
      const report = verdicts[r.campaign.id];
      const gaps = report?.assessment?.requirementGaps ?? [];
      const entry = byLevel.get(r.level) ?? { met: 0, total: 0 };
      for (const g of gaps) {
        entry.total += 1;
        if (g.met) entry.met += 1;
      }
      byLevel.set(r.level, entry);
    }
    return [...byLevel.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([level, v]) => ({ level, ...v, ratio: v.total ? v.met / v.total : 0 }));
  }, [rows, verdicts]);

  const totals = coverage.reduce(
    (acc, c) => ({ met: acc.met + c.met, total: acc.total + c.total }),
    { met: 0, total: 0 },
  );
  const score = totals.total ? Math.round((totals.met / totals.total) * 100) : 0;

  const stop = async (id: string) => {
    setBusy(id);
    try {
      await api.cancelDrsPlan(id);
      app.push('success', 'Cancellation requested — the exposure stops at the next checkpoint.');
      await app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head page-head--icon">
        <div>
          <h1>Overview</h1>
          <p className="hint">
            Is this protected, what is running, and what needs a decision. Nothing else.
          </p>
        </div>
      </div>

      {error && <p role="alert">{error}</p>}

      <div className="kpis">
        <Kpi value={clients.length} label="client dossiers" />
        <Kpi value={rows.length} label="DRS campaigns" />
        <Kpi
          value={capacity ? capacity.envelope.maxRps.toLocaleString() : '—'}
          label="envelope rps"
        />
        <Kpi value={capacity ? capacity.envelope.agents : '—'} label="admitted agents" />
      </div>

      <div className="grid2">
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div
              style={{
                fontSize: '2.4rem',
                fontWeight: 700,
                color: '#0a356b',
                letterSpacing: '-0.03em',
              }}
            >
              {score}
              <span style={{ fontSize: '.9rem', color: '#5b6b82', fontWeight: 500 }}>/100</span>
            </div>
            <div style={{ flex: 1 }}>
              <Bar
                value={totals.total ? totals.met / totals.total : 0}
                tone={score > 60 ? 'ok' : 'warn'}
                height={10}
              />
              <p className="hint" style={{ margin: '.4rem 0 0' }}>
                {totals.met} archived requirements reached out of {totals.total} across{' '}
                {clients.length} client(s).
              </p>
            </div>
          </div>

          <h2>Coverage by DRS level</h2>
          {coverage.length === 0 ? (
            <EmptyState title="No measured assessment yet">
              Coverage appears once a campaign has reached a verdict. Start with a client dossier.
            </EmptyState>
          ) : (
            <div style={{ display: 'grid', gap: '.5rem' }}>
              {coverage.map((c) => (
                <div
                  key={c.level}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '68px 1fr 84px',
                    gap: '.6rem',
                    alignItems: 'center',
                  }}
                >
                  <span className="hint" style={{ margin: 0 }}>
                    Level {c.level}
                  </span>
                  <Bar
                    value={c.ratio}
                    tone={c.ratio >= 0.6 ? 'ok' : c.ratio > 0 ? 'warn' : 'bad'}
                  />
                  <Chip tone={c.ratio >= 0.6 ? 'ok' : c.ratio > 0 ? 'warn' : 'bad'}>
                    {c.met} / {c.total}
                  </Chip>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div>
          <Card className={running.length > 0 ? 'ui-card-live' : ''}>
            <h2 style={{ marginTop: 0 }}>Running now</h2>
            {running.length === 0 ? (
              <EmptyState title="Nothing running">No exposure is in progress.</EmptyState>
            ) : (
              running.map((r) => (
                <div key={r.campaign.id} style={{ marginBottom: '.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                    <StateChip state={r.state} />
                    <b>{r.campaign.name}</b>
                  </div>
                  <p className="hint" style={{ margin: '.3rem 0 .5rem' }}>
                    {r.campaign.target} · DRS {r.level} · <ModeChip mode={r.mode} />
                  </p>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy === r.campaign.id}
                    onClick={() => void stop(r.campaign.id)}
                  >
                    {busy === r.campaign.id ? 'Stopping…' : 'Stop the exposure'}
                  </button>
                </div>
              ))
            )}
          </Card>

          <h2>Needs attention</h2>
          <div style={{ display: 'grid', gap: '.5rem' }}>
            {rows.filter(
              (r) =>
                r.state === 'FINAL_REPORT' &&
                verdicts[r.campaign.id]?.assessment?.status === 'INDETERMINATE',
            ).length > 0 && (
              <Card>
                <b>Indeterminate verdict</b>
                <p className="hint" style={{ margin: '.3rem 0 0' }}>
                  A campaign finished without a usable measurement. Open it to read why.
                </p>
              </Card>
            )}
            {(capacity?.calibrations.length ?? 0) === 0 && (
              <Card>
                <b>No calibrated agent</b>
                <p className="hint" style={{ margin: '.3rem 0 0' }}>
                  The envelope is zero and no exposure can start. Record a calibration.
                </p>
              </Card>
            )}
            {capacity &&
              capacity.envelope.maxRps === 0 &&
              (capacity.calibrations.length ?? 0) > 0 && (
                <Card>
                  <b>Envelope is zero</b>
                  <p className="hint" style={{ margin: '.3rem 0 0' }}>
                    Calibrations exist but no agent is admitted.
                  </p>
                </Card>
              )}
            {rows.length > 0 && coverage.length === 0 && (
              <Card>
                <b>No coverage measured yet</b>
                <p className="hint" style={{ margin: '.3rem 0 0' }}>
                  Campaigns exist but none has a sealed verdict.
                </p>
              </Card>
            )}
          </div>
        </div>
      </div>

      <h2>Latest verdicts</h2>
      {rows.filter((r) => r.finalizedAt).length === 0 ? (
        <EmptyState
          title="No verdict yet"
          action={
            <a className="btn btn-sm btn-primary" href="/campaigns/new">
              Start a campaign
            </a>
          }
        >
          Once a campaign is finalised its verdict appears here with its evidence count.
        </EmptyState>
      ) : (
        <table className="campaign-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Mode</th>
              <th>Verdict</th>
              <th>Proofs</th>
              <th>Date</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((r) => r.finalizedAt)
              .sort((a, b) => (b.finalizedAt ?? '').localeCompare(a.finalizedAt ?? ''))
              .slice(0, 5)
              .map((r) => {
                const report = verdicts[r.campaign.id];
                const status = report?.synthetic
                  ? 'SYNTHETIC'
                  : (report?.assessment?.status ?? '…');
                return (
                  <tr key={r.campaign.id}>
                    <td>
                      <a href={`/assessments/${r.campaign.id}`}>
                        <b>{r.campaign.name}</b>
                      </a>
                    </td>
                    <td>
                      <ModeChip mode={r.mode} />
                    </td>
                    <td>
                      <Chip tone={report?.synthetic ? 'plain' : verdictTone(status)}>{status}</Chip>
                    </td>
                    <td>{r.proofs}</td>
                    <td className="hint">{new Date(r.finalizedAt!).toLocaleString()}</td>
                    <td>
                      <a className="btn btn-sm" href={`/assessments/${r.campaign.id}`}>
                        Open
                      </a>
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
