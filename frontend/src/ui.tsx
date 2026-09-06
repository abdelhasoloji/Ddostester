import { useEffect, useRef, useState } from 'react';
import { reportUrl, runTimelineCsvUrl, streamUrl } from './api.js';
import type {
  Campaign,
  CampaignRun,
  CampaignStatus,
  RunSample,
  WrsBreakdown,
  WrsPoint,
  LiveProgressData,
} from './api.js';
import { useApp, canDo } from './context.js';
import { formatInterval } from './campaign-form.js';
// Re-exported so existing imports (pages.tsx, tests) keep resolving from './ui.js'.
export { NewCampaignForm } from './new-campaign-form.js';
export {
  buildAcceptance,
  buildAssertion,
  buildScenario,
  formatInterval,
  hostOf,
  parseDataset,
  parseEndpoints,
  parseFlow,
  parseFlowJson,
} from './campaign-form.js';

const badgeLabel: Record<CampaignStatus, string> = {
  PENDING_APPROVAL: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  KILLED_AUTO: 'Auto-killed',
  KILLED_MANUAL: 'Manually killed',
};

export function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="dot" />
      {badgeLabel[status]}
    </span>
  );
}

export function wrsClass(level: WrsBreakdown['level']): string {
  return 'wrs-' + level.replace('+', 'p');
}

export function VerdictBadge({ verdict }: { verdict: 'PASS' | 'FAIL' }) {
  return (
    <span
      className={`badge ${verdict === 'PASS' ? 'badge-APPROVED' : 'badge-REJECTED'}`}
      title="SLO acceptance verdict"
    >
      SLO {verdict}
    </span>
  );
}

export function WrsPill({ wrs }: { wrs: WrsBreakdown }) {
  return (
    <span className={`wrs ${wrsClass(wrs.level)}`} title="WEDOS Resiliency Score">
      <span className="wrs-score">{wrs.wrs}</span> {wrs.level}
    </span>
  );
}

/**
 * Full-width, interactive WRS trend for one target: hover a point for its
 * date/score, click it to open that run's report. Scales to its container
 * (viewBox matches measured pixel width, so points stay round).
 */
export function WrsTrend({ points, regression }: { points: WrsPoint[]; regression: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setW(Math.max(240, entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 120;
  const padX = 14;
  const padY = 18;
  const y = (v: number) => H - padY - (v / 100) * (H - 2 * padY);
  const xs =
    points.length > 1
      ? points.map((_, i) => padX + (i * (w - 2 * padX)) / (points.length - 1))
      : [w / 2];
  const ys = points.map((p) => y(p.wrs));
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const color = regression ? 'var(--danger)' : 'var(--brand)';
  const ty = y(70);

  const tipW = 150;
  const hi = hover;
  const tipX = hi !== null ? Math.min(Math.max(xs[hi] - tipW / 2, 2), w - tipW - 2) : 0;
  const tipAbove = hi !== null ? ys[hi] > 46 : true;
  const tipY = hi !== null ? (tipAbove ? ys[hi] - 44 : ys[hi] + 10) : 0;

  return (
    <div className="wrs-trend" ref={ref}>
      <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} role="img" aria-label="WRS trend">
        <line x1={padX} y1={ty} x2={w - padX} y2={ty} className="spark-thresh" />
        <text x={padX} y={ty - 4} className="trend-thresh-label">
          70
        </text>
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {xs.map((x, i) => (
          <a key={i} href={reportUrl(points[i].runId)} target="_blank" rel="noreferrer">
            <circle cx={x} cy={ys[i]} r={hover === i ? 5 : 3.5} fill={color} />
            <circle
              cx={x}
              cy={ys[i]}
              r="12"
              fill="transparent"
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          </a>
        ))}
        {hi !== null && (
          <g pointerEvents="none">
            <rect className="trend-tip-box" x={tipX} y={tipY} width={tipW} height={34} rx="6" />
            <text className="trend-tip-title" x={tipX + 8} y={tipY + 14}>
              WRS {points[hi].wrs} ({points[hi].level})
            </text>
            <text className="trend-tip-sub" x={tipX + 8} y={tipY + 27}>
              {new Date(points[hi].at).toLocaleString()}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

function LiveProgress({ campaignId, agent }: { campaignId: string; agent?: string }) {
  const [p, setP] = useState<LiveProgressData | null>(null);
  useEffect(() => {
    const es = new EventSource(streamUrl(campaignId));
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.status === 'RUNNING') setP(d);
        else if (d.status === 'done') es.close();
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [campaignId]);
  if (!p)
    return (
      <div className="details">
        <span className="hint">
          <span className="spin" />
          Starting run…
        </span>
      </div>
    );
  const pct = Math.min(100, Math.round((p.elapsedSec / Math.max(p.maxDurationSec, 1)) * 100));
  const engine = p.engine ?? agent;
  // The built-in engine reports per-request counters; external engines don't,
  // so we always show elapsed time + the live probe health instead.
  const hasCounters = p.sent > 0;
  return (
    <div className="details">
      <div className="live-bar">
        <div className="live-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="live-stats">
        <span>
          ⏱ {p.elapsedSec}s / {p.maxDurationSec}s
        </span>
        {hasCounters ? (
          <>
            <span>{p.sent} requests</span>
            <span>{p.actualRps} rps</span>
            <span>
              {p.successful} ok · {p.failed} failed
            </span>
          </>
        ) : (
          engine && <span>engine {engine} · running</span>
        )}
        {p.probe && p.probe.samples > 0 && (
          <span title="Legitimate probe against the target">
            🩺 probe {p.probe.available}/{p.probe.samples} up · {p.probe.errorRate5xx}% 5xx
          </span>
        )}
      </div>
    </div>
  );
}

export function CampaignCard({ c }: { c: Campaign }) {
  const app = useApp();
  const isBusy = app.busy[c.id];
  const role = app.role;
  const ar = app.authRequired;
  return (
    <div className="campaign">
      <div className="campaign-head">
        <span className="campaign-name">{c.name}</span>
        <StatusBadge status={c.status} />
        {c.wrs && <WrsPill wrs={c.wrs} />}
        {c.acceptanceResult && <VerdictBadge verdict={c.acceptanceResult.verdict} />}
        <div className="campaign-actions">
          {c.status === 'PENDING_APPROVAL' && canDo(role, 'approve', ar) && (
            <button className="btn btn-sm" disabled={isBusy} onClick={() => app.setApproveFor(c)}>
              Approve / Reject
            </button>
          )}
          {c.status === 'APPROVED' && canDo(role, 'execute', ar) && (
            <button
              className="btn btn-sm btn-primary"
              disabled={isBusy}
              onClick={() => app.setConfirmExec(c)}
            >
              {isBusy ? <span className="spin" /> : null}Run
            </button>
          )}
          {c.status === 'RUNNING' && canDo(role, 'kill', ar) && (
            <button className="btn btn-sm btn-danger" onClick={() => app.kill(c)}>
              Kill switch
            </button>
          )}
          {c.runId && (
            <a
              className="btn btn-sm btn-ghost"
              href={reportUrl(c.runId)}
              target="_blank"
              rel="noreferrer"
            >
              Report ↗
            </a>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => app.openDetail(c)}>
            Details
          </button>
        </div>
      </div>
      <div className="campaign-meta">
        <span>
          Target: <code>{c.target}</code>
        </span>
        <span>{c.vector}</span>
        {c.agent && c.agent !== 'builtin' && (
          <span title="Load engine" className="engine-tag">
            ⚙ {c.agent}
          </span>
        )}
        <span>
          {c.maxRps} rps · {c.concurrency} conc · {c.maxDurationSec}s
          {c.scenario && c.scenario.length > 1 ? ` · scenario ${c.scenario.length} phases` : ''}
        </span>
        <span>
          by {c.createdBy}
          {c.approvedBy ? ` · appr. ${c.approvedBy}` : ''}
        </span>
        {c.scheduledAt && (
          <span title="Scheduled run">🕒 {new Date(c.scheduledAt).toLocaleString()}</span>
        )}
        {c.recurrence && (
          <span title="Recurring campaign">
            🔁 every {formatInterval(c.recurrence.intervalMin)}
          </span>
        )}
        {c.flow && c.flow.length > 0 && (
          <span title="Multi-step L7 flow">🧭 {c.flow.length} steps</span>
        )}
        {c.suiteName && (
          <span title="Assessment playbook">
            📋 {c.suiteName}
            {typeof c.suiteOrder === 'number' ? ` #${c.suiteOrder + 1}` : ''}
          </span>
        )}
      </div>

      {c.status === 'RUNNING' && <LiveProgress campaignId={c.id} agent={c.agent} />}
    </div>
  );
}

/** Measured metrics + WRS breakdown for a finished run (used in the drawer). */
function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="metric">
      <div className="k">{label}</div>
      <div className="v">{children}</div>
    </div>
  );
}

/** Compact per-run time-series: requests/s and probe 5xx over elapsed time. */
function RunTimeline({ samples, csvHref }: { samples: RunSample[]; csvHref?: string }) {
  if (samples.length < 2) return null;
  const W = 640;
  const H = 120;
  const padX = 14;
  const padY = 16;
  const tMax = Math.max(...samples.map((s) => s.t), 1);
  const rpsMax = Math.max(...samples.map((s) => s.rps), 1);
  const errMax = Math.max(...samples.map((s) => s.probe5xx), 1);
  const x = (t: number) => padX + (t / tMax) * (W - 2 * padX);
  const yTop = padY;
  const yBot = H - padY;
  const line = (sel: (s: RunSample) => number, max: number) =>
    samples
      .map((s, i) => {
        const y = yBot - (sel(s) / max) * (yBot - yTop);
        return `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  return (
    <div className="posture">
      <div className="posture-title">Run timeline</div>
      <div className="wrs-trend">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Run timeline">
          <path d={line((s) => s.rps, rpsMax)} fill="none" stroke="var(--brand)" strokeWidth="2" />
          <path
            d={line((s) => s.probe5xx, errMax)}
            fill="none"
            stroke="var(--danger)"
            strokeWidth="2"
          />
        </svg>
      </div>
      <div className="timeline-legend">
        <span>
          <i style={{ background: 'var(--brand)' }} /> requests/s (peak {Math.round(rpsMax)})
        </span>
        <span>
          <i style={{ background: 'var(--danger)' }} /> probe 5xx % (peak {errMax.toFixed(1)})
        </span>
        <span className="hint">over {Math.round(tMax)}s</span>
        {csvHref && (
          <a href={csvHref} target="_blank" rel="noreferrer">
            CSV ↗
          </a>
        )}
      </div>
    </div>
  );
}

export function RunDetails({ run }: { run: CampaignRun }) {
  const g = run.generator;
  return (
    <div className="details">
      <div className="metrics">
        <Metric label="Requests">{g.totalRequests}</Metric>
        <Metric label="Success / failures">
          {g.successful} / {g.failed}
        </Metric>
        {g.assertionsChecked ? (
          <Metric label="Assertion failures">
            {g.assertionFailures ?? 0} / {g.assertionsChecked}
          </Metric>
        ) : null}
        <Metric label="Actual RPS">{g.actualRps}</Metric>
        <Metric label="Latency p95">{g.latencyMs.p95} ms</Metric>
        <Metric label="Probe 5xx">{run.probe.errorRate5xx}%</Metric>
        <Metric label="Probe availability">
          {run.probe.available}/{run.probe.samples}
        </Metric>
      </div>
      {Object.keys(g.statusCounts).length > 0 && (
        <div className="status-dist">
          {Object.entries(g.statusCounts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([bucket, n]) => (
              <span key={bucket} className={`chip-xs ${bucket === '2xx' ? 'on' : 'off'}`}>
                {bucket} {n}
              </span>
            ))}
          {Object.entries(g.errors).map(([name, n]) => (
            <span key={name} className="chip-xs off" title="transport/connection error">
              {name} {n}
            </span>
          ))}
        </div>
      )}
      {run.baseline && (
        <div className="metrics" style={{ marginTop: '.5rem' }}>
          <Metric label="Baseline availability">{run.baseline.availabilityPct}%</Metric>
          <Metric label="Baseline latency p95">{run.baseline.latencyMs.p95} ms</Metric>
          {run.baselineDelta && (
            <>
              <Metric label="Δ latency p95 (load)">
                {run.baselineDelta.latencyP95DeltaMs >= 0 ? '+' : ''}
                {run.baselineDelta.latencyP95DeltaMs} ms
              </Metric>
              <Metric label="Δ availability (load)">
                {run.baselineDelta.availabilityDeltaPct >= 0 ? '+' : ''}
                {run.baselineDelta.availabilityDeltaPct} pts
              </Metric>
            </>
          )}
        </div>
      )}
      {run.targetTelemetry && run.targetTelemetry.length > 0 && (
        <div className="metrics" style={{ marginTop: '.5rem' }}>
          {(() => {
            const peak = (
              pick: (s: NonNullable<CampaignRun['targetTelemetry']>[number]) => number | undefined,
            ) => {
              const vals = run.targetTelemetry!.map(pick).filter((v): v is number => v != null);
              return vals.length ? Math.max(...vals) : undefined;
            };
            const cpu = peak((s) => s.cpuPct);
            const ct = peak((s) => s.conntrack);
            return (
              <>
                {cpu != null && <Metric label="Target CPU peak">{cpu}%</Metric>}
                {ct != null && <Metric label="Target conntrack peak">{ct}</Metric>}
              </>
            );
          })()}
        </div>
      )}
      {run.timeline && (
        <RunTimeline samples={run.timeline} csvHref={runTimelineCsvUrl(run.runId)} />
      )}
      <div className="wrs-breakdown">
        <span>
          Detection{run.wrs.estimated ? ' (est.)' : ''} <b>{run.wrs.detection}</b>
        </span>
        <span>
          Mitigation{run.wrs.estimated ? ' (est.)' : ''} <b>{run.wrs.mitigation}</b>
        </span>
        <span>
          Availability <b>{run.wrs.availability}</b>
        </span>
        <span>
          Collateral <b>{run.wrs.collateral}</b>
        </span>
      </div>
      {run.wrs.estimated ? (
        <p className="hint" style={{ marginTop: '.5rem' }}>
          Detection and Mitigation are <b>estimated</b> (no protection integration): they are
          constant, so the WRS mostly reflects measured availability.
        </p>
      ) : (
        run.protectionSource && (
          <p className="hint" style={{ marginTop: '.5rem' }}>
            Detection and Mitigation <b>measured</b> by <code>{run.protectionSource}</code>.
          </p>
        )
      )}
      {run.acceptance && (
        <div className="posture">
          <div className="posture-title">
            SLO verdict <VerdictBadge verdict={run.acceptance.verdict} />
          </div>
          {run.acceptance.failures.length > 0 && (
            <ul className="slo-failures">
              {run.acceptance.failures.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {run.posture && (
        <div className="posture">
          <div className="posture-title">Protection posture (inferred from probe responses)</div>
          <div className="posture-chips">
            <span className={`chip-xs ${run.posture.waf ? 'on' : 'off'}`}>
              WAF {run.posture.waf ? '✓' : '—'}
            </span>
            <span className={`chip-xs ${run.posture.cdn ? 'on' : 'off'}`}>
              CDN {run.posture.cdn ? '✓' : '—'}
            </span>
            <span className={`chip-xs ${run.posture.rateLimiting ? 'on' : 'off'}`}>
              Rate limit {run.posture.rateLimiting ? '✓' : '—'}
            </span>
            <span className={`chip-xs ${run.posture.loadBalancer ? 'on' : 'off'}`}>
              Load balancer {run.posture.loadBalancer ? '✓' : '—'}
            </span>
            <span className={`chip-xs ${run.posture.hsts ? 'on' : 'off'}`}>
              HSTS {run.posture.hsts ? '✓' : '—'}
            </span>
          </div>
          {run.posture.server && <div className="hint">Server: {run.posture.server}</div>}
        </div>
      )}
    </div>
  );
}

/** Right-side detail panel for the campaign selected via "Details". */
export function CampaignDrawer() {
  const app = useApp();
  const id = app.expanded;
  const c = app.campaigns.find((x) => x.id === id);
  const role = app.role;
  const ar = app.authRequired;

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') app.setExpanded(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, app]);

  if (!id || !c) return null;
  const run = app.runs[c.id];
  return (
    <div className="drawer-overlay" onClick={() => app.setExpanded(null)}>
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Campaign details"
      >
        <div className="drawer-head">
          <div className="drawer-title">
            <span className="campaign-name">{c.name}</span>
            <StatusBadge status={c.status} />
            {c.wrs && <WrsPill wrs={c.wrs} />}
          </div>
          <button className="drawer-close" aria-label="Close" onClick={() => app.setExpanded(null)}>
            ×
          </button>
        </div>

        <div className="drawer-actions">
          {c.status === 'PENDING_APPROVAL' && canDo(role, 'approve', ar) && (
            <button className="btn btn-sm" onClick={() => app.setApproveFor(c)}>
              Approve / Reject
            </button>
          )}
          {c.status === 'APPROVED' && canDo(role, 'execute', ar) && (
            <button className="btn btn-sm btn-primary" onClick={() => app.setConfirmExec(c)}>
              Run
            </button>
          )}
          {c.status === 'RUNNING' && canDo(role, 'kill', ar) && (
            <button className="btn btn-sm btn-danger" onClick={() => app.kill(c)}>
              Kill switch
            </button>
          )}
          {c.runId && (
            <a
              className="btn btn-sm btn-ghost"
              href={reportUrl(c.runId)}
              target="_blank"
              rel="noreferrer"
            >
              Report ↗
            </a>
          )}
        </div>

        <dl className="drawer-meta">
          <div>
            <dt>Target</dt>
            <dd>
              <code>{c.target}</code>
            </dd>
          </div>
          <div>
            <dt>Probe</dt>
            <dd>
              <code>{c.probeUrl}</code>
            </dd>
          </div>
          <div>
            <dt>Vector</dt>
            <dd>{c.vector}</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>{c.agent ?? 'server default'}</dd>
          </div>
          <div>
            <dt>Load</dt>
            <dd>
              {c.maxRps} rps · {c.concurrency} conc · {c.maxDurationSec}s
              {c.scenario && c.scenario.length > 1 ? ` · ${c.scenario.length}-phase scenario` : ''}
            </dd>
          </div>
          <div>
            <dt>Author</dt>
            <dd>{c.createdBy}</dd>
          </div>
          {c.approvedBy && (
            <div>
              <dt>Approver</dt>
              <dd>{c.approvedBy}</dd>
            </div>
          )}
          {c.scheduledAt && (
            <div>
              <dt>{c.recurrence ? 'Next run' : 'Scheduled'}</dt>
              <dd>{new Date(c.scheduledAt).toLocaleString()}</dd>
            </div>
          )}
          {c.recurrence && (
            <div>
              <dt>Repeats</dt>
              <dd>every {formatInterval(c.recurrence.intervalMin)}</dd>
            </div>
          )}
          {c.flow && c.flow.length > 0 && (
            <div>
              <dt>Flow</dt>
              <dd>
                {c.flow.map((s, i) => {
                  let path = s.url;
                  try {
                    const u = new URL(s.url);
                    path = u.pathname + u.search;
                  } catch {
                    /* keep raw */
                  }
                  return (
                    <div key={i}>
                      <code>
                        {s.method} {path}
                      </code>
                      {s.thinkMs ? ` · think ${s.thinkMs}ms` : ''}
                      {s.extract ? ` · ⇒ {{${s.extract.name}}}` : ''}
                    </div>
                  );
                })}
              </dd>
            </div>
          )}
        </dl>

        {c.status === 'RUNNING' && <LiveProgress campaignId={c.id} agent={c.agent} />}
        {run ? (
          <RunDetails run={run} />
        ) : (
          c.status !== 'RUNNING' && (
            <p className="hint" style={{ marginTop: '.75rem' }}>
              No run yet — execute the campaign to see measured metrics and its WRS.
            </p>
          )
        )}
      </aside>
    </div>
  );
}

export function ExecuteModal() {
  const app = useApp();
  const c = app.confirmExec;
  if (!c) return null;
  return (
    <div className="overlay" onClick={() => app.setConfirmExec(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Confirm run</h3>
        <p>
          You are about to generate a bounded HTTP load of <b>{c.maxRps} rps</b> ({c.concurrency} in
          parallel) for <b>{c.maxDurationSec}s</b> against{' '}
          <span className="modal-target">{c.target}</span>. The kill switch stays available.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => app.setConfirmExec(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => app.execute(c)}>
            Launch campaign
          </button>
        </div>
      </div>
    </div>
  );
}

export function ApproveModal() {
  const app = useApp();
  const c = app.approveFor;
  const [approver, setApprover] = useState(app.identity?.email ?? app.operator);
  const [reason, setReason] = useState('');
  useEffect(
    () => setApprover(app.identity?.email ?? app.operator),
    [app.identity, app.operator, c],
  );
  if (!c) return null;
  const effective = app.authRequired ? (app.identity?.email ?? '') : approver;
  const sameAsAuthor = effective.trim() !== '' && effective.trim() === c.createdBy;
  return (
    <div className="overlay" onClick={() => app.setApproveFor(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Approval — {c.name}</h3>
        <p>Separation of duties: the approver must differ from the author ({c.createdBy}).</p>
        {app.authRequired ? (
          <p className="hint">
            Approver: <b>{app.identity?.email}</b>
          </p>
        ) : (
          <div className="field" style={{ marginBottom: '.75rem' }}>
            <label>Approver (Security Officer)</label>
            <input
              className={sameAsAuthor ? 'invalid' : ''}
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
            />
            {sameAsAuthor && (
              <span className="hint" style={{ color: 'var(--danger)' }}>
                Must differ from the author.
              </span>
            )}
          </div>
        )}
        <div className="field">
          <label>Reason (required for rejection)</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => app.setApproveFor(null)}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            disabled={sameAsAuthor || !reason.trim()}
            onClick={() => app.approve(c, effective.trim(), 'REJECTED', reason)}
          >
            Reject
          </button>
          <button
            className="btn btn-primary"
            disabled={sameAsAuthor || (!app.authRequired && !approver.trim())}
            onClick={() => app.approve(c, effective.trim(), 'APPROVED', reason)}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

export function Login() {
  const app = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await app.login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" style={{ maxWidth: 420, margin: '2rem auto' }}>
      <h2>Sign in</h2>
      {error && (
        <p
          style={{
            background: 'var(--danger-bg)',
            color: 'var(--danger)',
            padding: '.5rem .75rem',
            borderRadius: 6,
          }}
        >
          {error}
        </p>
      )}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
        <div className="field">
          <label>Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !email || !password}>
          {busy ? <span className="spin" /> : null}Sign in
        </button>
      </form>
    </section>
  );
}
