import { useEffect, useState } from 'react';
import { api, reportUrl, runTimelineCsvUrl, streamUrl } from './api.js';
import { PromChart, UplotChart, type ChartSeries } from './PromChart.js';
import { APP_VERSION_LABEL, APP_BUILT } from './version.js';
import type {
  Campaign,
  CampaignRun,
  CampaignStatus,
  Role,
  RunSample,
  WrsBreakdown,
  WrsPoint,
  LiveProgressData,
  MetricsRange,
} from './api.js';
import { useApp, canDo } from './context.js';
import { formatInterval } from './campaign-form.js';
// Re-exported so existing imports (pages.tsx, tests) keep resolving from './ui.js'.
export { NewCampaignForm } from './new-campaign-form.js';
export { NewCampaignWizard } from './new-campaign-wizard.js';
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
  CANCELLED: 'Cancelled',
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
 * Flags a WRS whose measurement may be understated because OUR generator host was
 * the bottleneck (hard-stopped, or high event-loop lag during the run) — so a low
 * score isn't misread as the target failing.
 */
export function ConfidenceBadge({ run }: { run: CampaignRun }) {
  if (!run.confidence?.degraded) return null;
  return (
    <span className="badge warn" title={run.confidence.reasons.join(' ')}>
      ⚠ measurement degraded
    </span>
  );
}

/**
 * Protection absorption widget: how much of the offered load the target's edge
 * absorbed (rate-limited / tarpitted / 4xx) vs let through to origin — the
 * product-level "protection working" signal, shown next to the WRS.
 */
export function AbsorptionWidget({ run }: { run: CampaignRun }) {
  const g = run.generator;
  const a =
    run.absorption ??
    ({
      configuredRps: 0,
      achievedRps: g.actualRps,
      originRps: 0,
      absorbedRatio: g.totalRequests ? g.failed / g.totalRequests : 0,
      absorbedPct: g.totalRequests ? Math.round((g.failed / g.totalRequests) * 1000) / 10 : 0,
      totalRequests: g.totalRequests,
    } as NonNullable<CampaignRun['absorption']>);
  return (
    <div className="absorption">
      <div className="absorption-head">
        <span>Protection absorption</span>
        <span className={`absorb-pct ${a.absorbedPct >= 20 ? 'good' : 'low'}`}>
          {a.absorbedPct}% absorbed by edge
        </span>
      </div>
      <div className="absorption-funnel">
        <div>
          <b>{a.configuredRps}</b>
          <span>configured</span>
        </div>
        <div className="arrow">→</div>
        <div>
          <b>{a.achievedRps.toFixed(1)}</b>
          <span>offered</span>
        </div>
        <div className="arrow">→</div>
        <div>
          <b>{a.originRps.toFixed(1)}</b>
          <span>reached origin</span>
        </div>
      </div>
      <div className="absorption-bar" title={`${a.absorbedPct}% absorbed by the target edge`}>
        <div className="absorb-fill" style={{ width: `${Math.min(100, a.absorbedPct)}%` }} />
      </div>
      {(a.rejectedRatio != null || a.tarpitRatio != null || a.offeredShortfall != null) && (
        <div
          className="absorb-mech"
          title="How the edge said no, and whether we could offer the configured rate"
        >
          <span className="mech reject">reject {((a.rejectedRatio ?? 0) * 100).toFixed(0)}%</span>
          <span className="mech tarpit">tarpit {((a.tarpitRatio ?? 0) * 100).toFixed(0)}%</span>
          <span className="mech shortfall">
            shortfall {((a.offeredShortfall ?? 0) * 100).toFixed(0)}%
          </span>
        </div>
      )}
      {run.edgeCorroboration && (
        <div
          className={`absorb-corr ${run.edgeCorroboration.agrees ? 'agree' : 'disagree'}`}
          title="Bilateral: our inferred absorption vs the edge's own report"
        >
          {run.edgeCorroboration.agrees ? '✓ corroborated' : '⚠ disagrees'} — edge reports{' '}
          {Math.round(run.edgeCorroboration.edgeAbsorbedRatio * 100)}% (
          {run.edgeCorroboration.source})
        </div>
      )}
    </div>
  );
}

/**
 * Full-width WRS trend for one target, rendered with uPlot (homogeneous with the
 * app's other charts): a fixed 0–100 scale, a dashed threshold at 70, and a
 * click on the plot opens the nearest run's report. Hover shows the value in the
 * legend; the x-axis carries the time.
 */
export function WrsTrend({ points, regression }: { points: WrsPoint[]; regression: boolean }) {
  const sorted = [...points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const series: ChartSeries[] = [
    {
      label: 'WRS',
      color: regression ? '#ef4444' : '#3b82f6',
      points: sorted.map((p) => [Date.parse(p.at) / 1000, p.wrs]),
    },
  ];
  return (
    <div className="wrs-trend">
      <UplotChart
        series={series}
        height={140}
        timeAxis
        yRange={[0, 100]}
        thresholds={[{ value: 70, label: 'target 70' }]}
        onPointClick={(i) => {
          const p = sorted[i];
          if (p) window.open(reportUrl(p.runId), '_blank', 'noopener');
        }}
      />
    </div>
  );
}

/**
 * v2 Run Theater — a focused, full-width live view of the running campaign. The
 * story is the two numbers pulling apart: offered load vs what reaches origin,
 * with the gap (what the edge absorbs) front and center, and the kill switch
 * always in reach. Subscribes to the same SSE stream as LiveProgress.
 */
export function RunTheater({
  campaignId,
  name,
  target,
  engine,
  onKill,
  killing,
}: {
  campaignId: string;
  name: string;
  target: string;
  engine?: string;
  onKill?: () => void;
  killing?: boolean;
}) {
  const [p, setP] = useState<LiveProgressData | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    const es = new EventSource(streamUrl(campaignId));
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.status === 'RUNNING') {
          setP(d);
          setWaiting(false);
        } else if (d.status === 'waiting') {
          setWaiting(true);
        } else if (d.status === 'done') {
          es.close();
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [campaignId]);

  const offered = p?.actualRps ?? 0;
  const originRps = p && p.elapsedSec > 0 ? p.successful / p.elapsedSec : 0;
  const absorbedPct = p && p.sent > 0 ? Math.round((p.failed / p.sent) * 100) : 0;
  const pct = p
    ? Math.min(100, Math.round((p.elapsedSec / Math.max(p.maxDurationSec, 1)) * 100))
    : 0;
  const eng = p?.engine ?? engine;

  return (
    <div className="theater">
      <div className="theater-head">
        <div>
          <div className="theater-title">{name}</div>
          <span className="hint">
            {target} · engine {eng ?? '—'}
            {p ? ` · ${p.elapsedSec}s / ${p.maxDurationSec}s` : ''}
          </span>
        </div>
        <span className={`badge ${absorbedPct >= 20 ? 'warn' : ''}`}>
          {waiting
            ? '● capturing baseline'
            : absorbedPct >= 20
              ? '● protection engaging'
              : '● running'}
        </span>
        {onKill && (
          <button className="btn btn-danger theater-kill" onClick={onKill} disabled={killing}>
            ◼ {killing ? 'Killing…' : 'Kill run'}
          </button>
        )}
      </div>
      <div className="live-bar">
        <div className="live-fill" style={{ width: `${pct}%` }} />
      </div>

      {!p ? (
        <p className="hint" style={{ marginTop: '1rem' }}>
          <span className="spin" /> {waiting ? 'Capturing pre-load baseline…' : 'Starting run…'}
        </p>
      ) : (
        <>
          <div className="theater-grid">
            <div className="theater-metric">
              <div className="tm-k">Offered</div>
              <div className="tm-v">
                {offered.toFixed(0)}
                <small>req/s</small>
              </div>
            </div>
            <div className="theater-metric">
              <div className="tm-k">Reached origin</div>
              <div className="tm-v good">
                {originRps.toFixed(0)}
                <small>req/s</small>
              </div>
            </div>
            <div className="theater-metric absorb">
              <div className="tm-k">Absorbed by edge</div>
              <div className="tm-v warnv">
                {absorbedPct}
                <small>%</small>
              </div>
              <div className="absorption-bar" style={{ marginTop: '.4rem' }}>
                <div className="absorb-fill" style={{ width: `${Math.min(100, absorbedPct)}%` }} />
              </div>
            </div>
            <div className="theater-metric">
              <div className="tm-k">
                Legit probe
                {p.probe?.health && p.probe.health !== 'ok' && (
                  <span className={`health-badge health-${p.probe.health}`}>
                    {p.probe.health === 'critical' ? '● critical' : '▲ degraded'}
                  </span>
                )}
              </div>
              <div
                className={`tm-v ${p.probe?.health === 'critical' ? 'bad' : p.probe?.health === 'degraded' ? 'warnv' : 'good'}`}
              >
                {p.probe && p.probe.samples > 0
                  ? Math.round((p.probe.available / p.probe.samples) * 100)
                  : 100}
                <small>% up</small>
              </div>
            </div>
          </div>

          {p.statusCounts && Object.keys(p.statusCounts).length > 0 && (
            <div className="status-dist" style={{ marginTop: '.8rem' }}>
              {Object.entries(p.statusCounts)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([bucket, n]) => (
                  <span key={bucket} className={`chip-xs ${bucket === '2xx' ? 'on' : 'off'}`}>
                    {bucket} {n}
                  </span>
                ))}
            </div>
          )}

          {p.timeline && p.timeline.length >= 2 && (
            <div style={{ marginTop: '.8rem' }}>
              <RunTimeline samples={p.timeline} />
            </div>
          )}

          <LiveRpsChart target={target} />
        </>
      )}
    </div>
  );
}

/**
 * App-native, Grafana-style live chart (option B): polls the same Prometheus
 * that feeds Grafana (via /api/metrics/range) and renders it with uPlot — the
 * engine Grafana uses. Hides itself when Prometheus isn't wired (`source` not
 * "ok") or has no points yet, so the app degrades gracefully.
 */
function LiveRpsChart({ target }: { target: string }) {
  const [range, setRange] = useState<MetricsRange | null>(null);
  let host = target;
  try {
    host = new URL(target).hostname;
  } catch {
    /* keep raw */
  }
  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .metricsRange('run_rps', { target: host, minutes: 15, step: 5 })
        .then((r) => {
          if (alive) setRange(r);
        })
        .catch(() => undefined);
    pull();
    const t = setInterval(pull, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [host]);

  if (!range || range.source !== 'ok') return null;
  if (!range.series.some((s) => s.points.length > 0)) return null;
  return (
    <div className="figure" style={{ marginTop: '.8rem' }}>
      <div className="posture-title">
        Live RPS · Grafana-style <span className="hint">(uPlot, from Prometheus)</span>
      </div>
      <PromChart range={range} height={200} />
    </div>
  );
}

function LiveProgress({ campaignId, agent }: { campaignId: string; agent?: string }) {
  const [p, setP] = useState<LiveProgressData | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    const es = new EventSource(streamUrl(campaignId));
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.status === 'RUNNING') {
          setP(d);
          setWaiting(false);
        } else if (d.status === 'waiting') {
          // Run has started but is still capturing the pre-load baseline — keep
          // the stream open (don't close) and show a "capturing baseline" note.
          setWaiting(true);
        } else if (d.status === 'done') {
          es.close();
        }
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
          {waiting ? 'Capturing pre-load baseline…' : 'Starting run…'}
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
            {p.elapsedSec > 0 && (
              <span
                className="live-absorb"
                title="Load reaching origin (2xx/3xx) vs the share the edge is absorbing right now"
              >
                → origin {(p.successful / p.elapsedSec).toFixed(1)}/s ·{' '}
                <b>{p.sent > 0 ? Math.round((p.failed / p.sent) * 100) : 0}% absorbed</b>
              </span>
            )}
          </>
        ) : (
          engine && <span>engine {engine} · running</span>
        )}
        {hasCounters && p.latencyMs && (
          <span title="Live latency percentiles over the run so far">
            ⚡ p50 {p.latencyMs.p50} · p95 {p.latencyMs.p95} · p99 {p.latencyMs.p99} ms
          </span>
        )}
        {p.probe && p.probe.samples > 0 && (
          <span title="Legitimate probe against the target">
            🩺 probe {p.probe.available}/{p.probe.samples} up · {p.probe.errorRate5xx}% 5xx
          </span>
        )}
        {p.probe?.health && p.probe.health !== 'ok' && (
          <span
            className={`health-badge health-${p.probe.health}`}
            title={
              p.probe.health === 'critical'
                ? 'Target availability at the auto-kill threshold — the run may be stopped to protect it'
                : 'Target degrading — availability or latency is off nominal (early warning before any auto-kill)'
            }
          >
            {p.probe.health === 'critical' ? '● critical' : '▲ degraded'}
          </span>
        )}
      </div>
      {p.statusCounts && Object.keys(p.statusCounts).length > 0 && (
        <div className="status-dist">
          {Object.entries(p.statusCounts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([bucket, n]) => (
              <span key={bucket} className={`chip-xs ${bucket === '2xx' ? 'on' : 'off'}`}>
                {bucket} {n}
              </span>
            ))}
        </div>
      )}
      {p.timeline && p.timeline.length >= 2 && <RunTimeline samples={p.timeline} />}
    </div>
  );
}

/**
 * Separation of duties (extended): the officer who approved a campaign may not
 * also execute it. Hide Run from the approver so no visible action leads to a
 * 403. Only meaningful when auth identifies the viewer.
 */
function canRunCampaign(
  c: Campaign,
  role: Role | null,
  ar: boolean,
  myEmail?: string,
  requireCiso = false,
): boolean {
  if (c.status !== 'APPROVED' || !canDo(role, 'execute', ar)) return false;
  if (ar && myEmail && c.approvedBy && myEmail.toLowerCase() === c.approvedBy.toLowerCase()) {
    return false;
  }
  // Dual control: no Run until the mandatory CISO sign-off is present.
  if (requireCiso && !c.cisoApprovedBy) return false;
  return true;
}

/** Whether to offer the CISO sign-off action on this campaign to this viewer. */
function canCisoApprove(c: Campaign, role: Role | null, ar: boolean): boolean {
  return c.status === 'APPROVED' && !c.cisoApprovedBy && canDo(role, 'cisoApprove', ar);
}

/** A small badge showing the dual-control sign-off state. */
export function CisoBadge({ c }: { c: Campaign }) {
  if (c.cisoApprovedBy) {
    return (
      <span className="badge badge-APPROVED" title={`CISO sign-off by ${c.cisoApprovedBy}`}>
        CISO ✓
      </span>
    );
  }
  return (
    <span className="badge badge-PENDING_APPROVAL" title="Awaiting mandatory CISO sign-off">
      CISO pending
    </span>
  );
}

export function CampaignCard({ c }: { c: Campaign }) {
  const app = useApp();
  const isBusy = app.busy[c.id];
  const role = app.role;
  const ar = app.authRequired;
  const canRun = canRunCampaign(c, role, ar, app.identity?.email, app.requireCisoApproval);
  const showCiso = app.requireCisoApproval && c.status !== 'PENDING_APPROVAL';
  return (
    <div className={`campaign${c.archived ? ' is-archived' : ''}`}>
      <div className="campaign-head">
        <span className="campaign-name">{c.name}</span>
        {c.archived && (
          <span className="badge badge-CANCELLED" title="Archived">
            Archived
          </span>
        )}
        <StatusBadge status={c.status} />
        {showCiso && <CisoBadge c={c} />}
        {c.wrs && <WrsPill wrs={c.wrs} />}
        {c.acceptanceResult && <VerdictBadge verdict={c.acceptanceResult.verdict} />}
        <div className="campaign-actions">
          {c.status === 'PENDING_APPROVAL' && canDo(role, 'approve', ar) && (
            <button className="btn btn-sm" disabled={isBusy} onClick={() => app.setApproveFor(c)}>
              Approve / Reject
            </button>
          )}
          {canCisoApprove(c, role, ar) && (
            <button
              className="btn btn-sm btn-primary"
              disabled={isBusy}
              onClick={() => app.cisoApprove(c)}
              title="Mandatory CISO sign-off (dual control)"
            >
              {isBusy ? <span className="spin" /> : null}CISO sign-off
            </button>
          )}
          {canRun && (
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
          {(c.status === 'PENDING_APPROVAL' || c.status === 'APPROVED') &&
            canDo(role, 'approve', ar) && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={isBusy}
                onClick={() => app.cancel(c)}
                title="Cancel this unrun campaign (terminal)"
              >
                Cancel
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
          {canDo(role, 'create', ar) && c.status !== 'RUNNING' && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={isBusy}
              onClick={() => app.archive(c, !c.archived)}
              title={
                c.archived
                  ? 'Restore to the active list'
                  : 'Archive — hide from the default campaigns list'
              }
            >
              {c.archived ? 'Restore' : 'Archive'}
            </button>
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

      {c.statusDetail &&
        (c.status === 'KILLED_AUTO' ||
          c.status === 'KILLED_MANUAL' ||
          c.status === 'CANCELLED') && (
          <div className="kill-note" role="note">
            <span aria-hidden="true">🛑</span> {c.statusDetail}
          </div>
        )}

      {/* Only mount the inline live stream when the detail drawer is NOT open
          for this campaign — otherwise the drawer already shows it and both
          would open their own EventSource to the same /stream. */}
      {c.status === 'RUNNING' && app.expanded !== c.id && (
        <LiveProgress campaignId={c.id} agent={c.agent} />
      )}
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

/** Per-run time-series (client-side, every engine): requests/s and probe 5xx
 *  over elapsed seconds, rendered with uPlot so it matches the other charts. */
function RunTimeline({ samples, csvHref }: { samples: RunSample[]; csvHref?: string }) {
  if (samples.length < 2) return null;
  const tMax = Math.round(Math.max(...samples.map((s) => s.t), 1));
  const series: ChartSeries[] = [
    { label: 'requests/s', points: samples.map((s) => [s.t, s.rps]), color: '#3b82f6' },
    {
      label: 'probe 5xx %',
      points: samples.map((s) => [s.t, s.probe5xx]),
      color: '#ef4444',
      axis: 'right',
    },
  ];
  return (
    <div className="posture">
      <div className="posture-title">Run timeline</div>
      <UplotChart series={series} height={150} timeAxis={false} />
      <div className="timeline-legend">
        <span className="hint">over {tMax}s</span>
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
      <AbsorptionWidget run={run} />
      {run.confidence?.degraded && (
        <p className="hint warn-hint" style={{ marginTop: '.5rem' }}>
          ⚠ <b>Measurement degraded — this WRS may be understated.</b>{' '}
          {run.confidence.reasons.join(' ')}
        </p>
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
        run.protection && (
          <div className="posture">
            <div className="posture-title">
              Protection (measured by <code>{run.protection.source ?? '—'}</code>)
            </div>
            <div className="metric-grid">
              <Metric label="Time to detect (TTD)">{run.protection.detectionTimeSec}s</Metric>
              <Metric label="Time to mitigate (TTM)">{run.protection.mitigationTimeSec}s</Metric>
            </div>
          </div>
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
  const canRun = c
    ? canRunCampaign(c, role, ar, app.identity?.email, app.requireCisoApproval)
    : false;

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
            {app.requireCisoApproval && c.status !== 'PENDING_APPROVAL' && <CisoBadge c={c} />}
            {c.wrs && <WrsPill wrs={c.wrs} />}
            {run && <ConfidenceBadge run={run} />}
          </div>
          <button className="drawer-close" aria-label="Close" onClick={() => app.setExpanded(null)}>
            ×
          </button>
        </div>

        {c.statusDetail && (c.status === 'KILLED_AUTO' || c.status === 'KILLED_MANUAL') && (
          <div className="kill-note" role="note">
            <span aria-hidden="true">🛑</span> {c.statusDetail}
          </div>
        )}

        <div className="drawer-actions">
          {c.status === 'PENDING_APPROVAL' && canDo(role, 'approve', ar) && (
            <button className="btn btn-sm" onClick={() => app.setApproveFor(c)}>
              Approve / Reject
            </button>
          )}
          {canCisoApprove(c, role, ar) && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => app.cisoApprove(c)}
              title="Mandatory CISO sign-off (dual control)"
            >
              CISO sign-off
            </button>
          )}
          {canRun && (
            <button className="btn btn-sm btn-primary" onClick={() => app.setConfirmExec(c)}>
              Run
            </button>
          )}
          {c.status === 'RUNNING' && canDo(role, 'kill', ar) && (
            <button className="btn btn-sm btn-danger" onClick={() => app.kill(c)}>
              Kill switch
            </button>
          )}
          {(c.status === 'PENDING_APPROVAL' || c.status === 'APPROVED') &&
            canDo(role, 'approve', ar) && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => app.cancel(c)}
                title="Cancel this unrun campaign (terminal)"
              >
                Cancel
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
      <div style={{ textAlign: 'center', marginTop: '1rem' }}>
        <span className="version-tag" title={APP_BUILT ? `Built ${APP_BUILT}` : undefined}>
          {APP_VERSION_LABEL}
        </span>
      </div>
    </section>
  );
}
