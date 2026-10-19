import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, type Campaign, type DrsReportView } from './api.js';
import { useApp } from './context.js';
import { LineIcon } from './interface-kit.js';

interface Row {
  campaign: Campaign;
  state: string;
  level: number;
  proofs: number;
  finalized: boolean;
  mode: string;
}

function rowOf(c: Campaign): Row | null {
  const doc = c.drsDocument;
  if (!doc) return null;
  const rev =
    (doc.revisions ?? []).find((r) => r.number === doc.currentRevision) ?? doc.revisions?.[0];
  if (!rev) return null;
  const plan = (rev.plan ?? {}) as { maxLevel?: unknown; mode?: unknown };
  return {
    campaign: c,
    state: rev.state ?? 'DRAFT',
    level: typeof plan.maxLevel === 'number' ? plan.maxLevel : 1,
    proofs: (rev.proofs ?? []).length,
    finalized: Boolean(rev.finalizedAt),
    mode: typeof plan.mode === 'string' ? plan.mode : '—',
  };
}

/**
 * DRS workspace: every campaign that carries a frozen DRS plan, its execution state, the
 * number of sealed proofs, and the two reports the client receives. Execution is started
 * here and the orchestrator checkpoints its transitions on the revision, so the list is
 * the live view of the assessment.
 */
export function DrsPage() {
  const app = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, DrsReportView>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = useMemo(
    () => app.campaigns.map(rowOf).filter((r): r is Row => r !== null),
    [app.campaigns],
  );
  const running = rows.some(
    (r) => !r.finalized && r.state !== 'PLAN_FROZEN' && r.state !== 'DRAFT',
  );

  // A plan in flight changes state every few seconds; poll only while one is running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => app.refresh(), 4000);
    return () => clearInterval(t);
  }, [running, app]);

  // Fetch the report only for finalized revisions, once each: the verdict and the unmet
  // requirements are what the client receives.
  useEffect(() => {
    const finalized = rows.filter((r) => r.finalized && !reports[r.campaign.id]);
    if (finalized.length === 0) return;
    let cancelled = false;
    void Promise.all(
      finalized.map(async (r) => {
        try {
          const report = await api.drsCampaignReport(r.campaign.id);
          if (!cancelled) setReports((prev) => ({ ...prev, [r.campaign.id]: report }));
        } catch {
          /* a report that cannot be read is simply absent from the list */
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [rows, reports]);

  const replay = async (id: string) => {
    setBusy(id + ':replay');
    try {
      const created = await api.replayDrsPlan(id);
      app.push('success', `Replay created — ${created.name}.`);
      await app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const execute = async (id: string) => {
    setBusy(id);
    try {
      await api.executeDrsPlan(id);
      app.push('success', 'DRS execution started — the revision advances as it runs.');
      await app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>DRS assessments</h1>
          <p className="hint">
            Frozen plans, their execution state and the sealed evidence. A verdict is never
            certified: the assessment states the requirements the fleet did not reach.
          </p>
        </div>
        <span className="page-head-icon" aria-hidden="true">
          <LineIcon name="shield" />
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="hint">
          No DRS plan yet. Create one from <a href="/capacity">Capacity</a>.
        </p>
      ) : (
        <table className="campaign-table">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Mode</th>
              <th>Level</th>
              <th>State</th>
              <th>Proofs</th>
              <th>Verdict</th>
              <th>Reports</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ campaign, state, level, proofs, finalized, mode }) => (
              <Fragment key={campaign.id}>
                <tr
                  onClick={() => setExpanded(expanded === campaign.id ? null : campaign.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <b>{campaign.name}</b>
                    <div className="hint">{campaign.target}</div>
                  </td>
                  <td>{mode}</td>
                  <td>DRS {level}</td>
                  <td>
                    {state}
                    {finalized ? ' · finalized' : ''}
                  </td>
                  <td>{proofs}</td>
                  <td>
                    {reports[campaign.id]
                      ? `${reports[campaign.id].assessment.status} · ${reports[campaign.id].assessment.terminalOutcome}${reports[campaign.id].assessment.score === null ? '' : ' · ' + reports[campaign.id].assessment.score}`
                      : finalized
                        ? '…'
                        : '—'}
                  </td>
                  <td>
                    <a
                      href={`/api/campaigns/${encodeURIComponent(campaign.id)}/drs/report.html`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      report
                    </a>{' '}
                    ·{' '}
                    <a
                      href={`/api/campaigns/${encodeURIComponent(campaign.id)}/drs/report.json`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      json
                    </a>
                  </td>
                  <td>
                    <button
                      className="btn btn-sm"
                      disabled={busy === campaign.id + ':replay'}
                      onClick={(e) => {
                        e.stopPropagation();
                        void replay(campaign.id);
                      }}
                    >
                      {busy === campaign.id + ':replay' ? 'Replaying…' : 'Replay'}
                    </button>{' '}
                    {!finalized && state === 'PLAN_FROZEN' && (
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={busy === campaign.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void execute(campaign.id);
                        }}
                      >
                        {busy === campaign.id ? 'Starting…' : 'Execute'}
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === campaign.id && (
                  <tr>
                    <td colSpan={8}>
                      {reports[campaign.id] ? (
                        <>
                          <div className="hint">
                            Bounded by the archived requirements below; unmet rows are why the
                            verdict is not a pass.
                          </div>
                          <table className="campaign-table">
                            <thead>
                              <tr>
                                <th>Vector</th>
                                <th>Level</th>
                                <th>Dimension</th>
                                <th>Required</th>
                                <th>Recorded</th>
                                <th>Met</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(reports[campaign.id].assessment.requirementGaps ?? []).map((g) => (
                                <tr key={g.vectorId + g.dimension}>
                                  <td>{g.vectorId}</td>
                                  <td>{g.level}</td>
                                  <td>{g.dimension}</td>
                                  <td>{g.required}</td>
                                  <td>{g.achieved}</td>
                                  <td>{g.met ? 'yes' : <b>no</b>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      ) : (
                        <span className="hint">Report not finalized yet.</span>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
