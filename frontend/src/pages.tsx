import { DrsCatalogPanel } from './drs-catalog.js';
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom';
import { AssistantChat } from './assistant-chat.js';
import { FleetOperations } from './fleet-operations.js';
import { lsGet, lsSet } from './storage.js';
import {
  api,
  auditExportUrl,
  reportUrl,
  suiteReportUrl,
  getGrafanaBase,
  grafanaDashUrl,
} from './api.js';
import type {
  ImpactEntry,
  GrafanaPlane,
  AuditVerdict,
  Campaign,
  CampaignRun,
  CampaignStatus,
  AbsorptionSummaryRow,
  Role,
  SuiteSequenceState,
  WrsBreakdown,
  ControlKey,
  ControlStatus,
  ProtectionProfile,
  InferredProfile,
  NetworkLadder,
  GapAnalysis,
  Priority,
} from './api.js';
import { GAP_CONTROLS } from './api.js';
import { defaultTargetUrl } from './target-url.js';
import { useApp, canDo, roleLabel } from './context.js';
import { APP_VERSION_LABEL, APP_BUILT, APP_COMMIT } from './version.js';
import {
  ApproveModal,
  CampaignCard,
  CampaignDrawer,
  ChangePasswordForm,
  ExecuteModal,
  NewCampaignForm,
  StatusBadge,
  WrsPill,
  WrsTrend,
  wrsClass,
  AbsorptionWidget,
  AiSupportButton,
  hostOf,
} from './ui.js';
import { onAiSupport } from './assistant-bus.js';
import { ReconFirstCreate } from './recon-first-create.js';
import { presetSeed } from './campaign-form.js';
import { gradeFromScore } from './wrs.js';
import { Modal } from './modal.js';
import { BenchCard } from './bench-card.js';
import { NotificationsBell, useOpenAlert } from './notifications.js';
import {
  PurgeCard,
  UsersCard,
  LimitsCard,
  NotificationsCard,
  ObservabilityCard,
} from './settings-cards.js';
import { getTheme, setTheme as persistTheme, subscribeTheme } from './theme.js';
import type { Theme } from './theme.js';

/** What each role can do — shown on the account page so a user understands their
 *  own access. Keyed by role id so it tracks the RBAC model. */
const roleDescription: Record<Role, string> = {
  engineer: 'Create campaigns and launch an approved one (and stop runs).',
  ciso: 'Validate (approve) campaigns, co-sign under dual control, and govern the class-C bench.',
  admin: 'Manage accounts, targets, campaigns, execution, reports and operational limits.',
  viewer: 'Read-only access to campaigns, results and assurance.',
};

// ---------- sidebar + layout ----------
// Legacy routes remain available; DRS planning uses a smaller primary navigation.
const SPINE_NAV = [
  { to: '/', label: 'Command Center', icon: '🛰', end: true },
  { to: '/zones', label: 'Protected zones', icon: '🛡' },
  { to: '/campaigns', label: 'Campaigns', icon: '🎯' },
  { to: '/fleet', label: 'Fleet', icon: '🤖' },
  { to: '/theater', label: 'Run Theater', icon: '🎬' },
  { to: '/reports', label: 'Results', icon: '📊' },
  { to: '/assistant', label: 'Assistant', icon: '💬' },
  // Prepare retired from the spine; the audit log now lives in Settings.
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

const WORKSPACE_NAV = [
  { to: '/', label: 'Overview', icon: '◉', end: true },
  { to: '/clients', label: 'Clients', icon: '▦', end: false },
  { to: '/infrastructure', label: 'Infrastructure', icon: '▤', end: false },
  { to: '/reports', label: 'Evidence archive', icon: '▧', end: false },
];

const THEME_OPTS: [Theme, string, string][] = [
  ['light', '☀', 'Light'],
  ['system', '🖥', 'System'],
  ['dark', '☾', 'Dark'],
];

/** Shared, reactive theme value — every toggle on screen re-renders together. */
function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}

function ThemeToggle() {
  const theme = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {THEME_OPTS.map(([v, icon, label]) => (
        <button
          key={v}
          type="button"
          className={`theme-btn${theme === v ? ' active' : ''}`}
          title={`Theme: ${label}`}
          aria-pressed={theme === v}
          onClick={() => persistTheme(v)}
        >
          <span aria-hidden="true">{icon}</span>
        </button>
      ))}
    </div>
  );
}

/** The installed/available load-engine rows — shared by Settings and the Guide. */
export function EnginesList() {
  const app = useApp();
  if (app.agents.length === 0) {
    return <span className="hint">No engine information available.</span>;
  }
  return (
    <div className="engines">
      {app.agents.map((a) => (
        <div key={a.id} className="engine-row">
          <span className={`engine-dot ${a.available ? 'on' : 'off'}`} />
          <span className="engine-name">{a.name}</span>
          <span className={`engine-badge ${a.available ? 'ok' : 'no'}`}>
            {a.available ? 'Installed' : 'Not installed'}
          </span>
          {!a.multiPhase && <span className="engine-cap">constant only</span>}
          <span className="engine-desc">{a.description}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * True when the API server serves a different commit than this bundle was built
 * from — i.e. a partial deploy or a stale cached bundle (exactly the "served old
 * code" trap we hit). Only fires when both commits are real (not "dev").
 */
export function isBuildMismatch(
  server: { commit: string } | null,
  frontendCommit: string = APP_COMMIT,
): boolean {
  if (!server) return false;
  const s = server.commit;
  if (!s || s === 'dev' || !frontendCommit || frontendCommit === 'dev') return false;
  return s !== frontendCommit;
}

// gradeFromScore + the WRS_LEVELS legend ranges both derive from WRS_BANDS in
// wrs.ts (the single source of truth), so the Command Center pill can never
// disagree with the guide legend.

/** Role-shaped call-to-action on the Command Center: each role opens on what its
 *  job is (Officer → approvals, CISO → governance, Engineer → run, Viewer → watch). */
function RoleFocus() {
  const app = useApp();
  const role = app.role;
  // Steps of an actively-sequencing suite are auto-approved just-in-time by the
  // sequencer — they are not an action item for the officer, so exclude them
  // from the "awaiting approval" count (they'd otherwise show as a false queue
  // right after the operator clicked "Run suite").
  const seqs = useSuiteSequences();
  const inActiveSequence = (c: Campaign) => !!c.suiteId && c.suiteId in seqs;
  const pending = app.campaigns.filter(
    (c) => c.status === 'PENDING_APPROVAL' && !inActiveSequence(c),
  );
  const running = app.campaigns.filter((c) => c.status === 'RUNNING');
  let label = 'For the Engineer';
  let body: React.ReactNode = running.length ? (
    <>
      <b>{running.length}</b> run{running.length === 1 ? '' : 's'} live —{' '}
      <Link to="/theater">open Run Theater →</Link>
    </>
  ) : (
    <>
      Ready to test. <Link to="/campaigns">New campaign →</Link>
    </>
  );
  if (role === 'ciso') {
    label = 'For the CISO';
    body = pending.length ? (
      <>
        <b>{pending.length}</b> campaign{pending.length === 1 ? '' : 's'} awaiting your approval.{' '}
        <Link to="/campaigns">Review →</Link>
      </>
    ) : (
      <>
        No approvals waiting. Governance &amp; the tamper-evident audit log in{' '}
        <Link to="/settings">Settings →</Link>
      </>
    );
  } else if (role === 'admin') {
    label = 'For the Administrator';
    body = (
      <>
        Administer the platform — users, roles and the operational limits in{' '}
        <Link to="/settings">Settings →</Link>
      </>
    );
  } else if (role === 'viewer') {
    label = 'For you';
    body = (
      <>
        Read-only access. Watch live in <Link to="/theater">Run Theater</Link>.
      </>
    );
  }
  return (
    <div className="role-focus">
      <span className="rf-label">{label}</span>
      <span className="rf-body">{body}</span>
    </div>
  );
}

/**
 * v2 Command Center — the new front door. Composes fleet resilience, live alerts,
 * runs in flight, generator health and the last result (with its absorption) from
 * data already in context, so one scan tells you if anything needs you.
 */
/** Command Center panel: per-attack-shape absorption from /api/observability/summary
 *  (the durable-history rollup, not the lossy _last gauges). Hidden until data exists. */
function AbsorptionByShape() {
  const [rows, setRows] = useState<AbsorptionSummaryRow[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .observabilitySummary()
      .then((r) => live && setRows(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!rows || rows.length === 0) return null;
  const host = (t: string) => {
    try {
      return new URL(t).hostname;
    } catch {
      return t;
    }
  };
  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <div className="card-head">
        <div className="section-title">Absorption by attack shape</div>
        <AiSupportButton
          title="Absorption by attack shape"
          context="the Command Center table breaking down, per target and vector, how much offered load the edge absorbed (last vs mean) and the resulting WRS."
        />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="kvs abs-shape">
          <thead>
            <tr>
              <th>Target</th>
              <th>Vector</th>
              <th>Runs</th>
              <th>Absorbed (last / mean)</th>
              <th>Mechanism (last)</th>
              <th>WRS</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((r) => (
              <tr key={`${r.target} ${r.vector}`}>
                <td>{host(r.target)}</td>
                <td>
                  <code>{r.vector}</code>
                </td>
                <td>{r.runs}</td>
                <td>
                  <b>{r.lastAbsorbedPct}%</b> <span className="muted">/ {r.meanAbsorbedPct}%</span>
                </td>
                <td className="muted" style={{ fontSize: '.78rem' }}>
                  reject {r.lastRejectedPct}% · tarpit {r.lastTarpitPct}% · shortfall{' '}
                  {r.lastOfferedShortfallPct}%
                </td>
                <td>{r.lastWrs ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Fetches the impact leaderboard (E16) — steps that floored the target. Kept
 *  local (not in the global context) so it only loads on the Command Center. */
function useImpact(): ImpactEntry[] {
  const [impact, setImpact] = useState<ImpactEntry[]>([]);
  useEffect(() => {
    let live = true;
    api
      .impact(20)
      .then((r) => {
        if (live) setImpact(r.impact ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return impact;
}

export function CommandCenterPage() {
  const app = useApp();
  const openAlert = useOpenAlert();
  const c = app.campaigns;
  const scored = c.filter((x) => x.wrs);
  const fleet = scored.length
    ? Math.round(scored.reduce((s, x) => s + (x.wrs?.wrs ?? 0), 0) / scored.length)
    : null;
  const running = c.filter((x) => x.status === 'RUNNING');
  const alerts = app.alerts ?? [];
  const impact = useImpact();
  const degraded = alerts.some((a) => a.kind === 'degraded');
  const health = degraded ? 'degraded' : running.length ? 'busy' : 'nominal';
  // Last result = the genuinely most-recent run (by WRS-history timestamp), not
  // just the first scored campaign in list order.
  const latestPoint = app.wrsSeries
    .flatMap((s) => s.points.map((p) => ({ ...p, target: s.target })))
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const latestCampaign = latestPoint ? c.find((x) => x.runId === latestPoint.runId) : undefined;
  const fallback = scored.find((x) => x.runId) ?? scored[0];
  const last = latestPoint
    ? {
        runId: latestPoint.runId,
        name: latestCampaign?.name ?? latestPoint.target,
        target: latestCampaign?.target ?? latestPoint.target,
        wrs: (latestCampaign?.wrs ?? {
          wrs: latestPoint.wrs,
          level: latestPoint.level,
        }) as WrsBreakdown,
      }
    : fallback
      ? {
          runId: fallback.runId!,
          name: fallback.name,
          target: fallback.target,
          wrs: fallback.wrs!,
        }
      : null;
  const trend = app.wrsSeries.find((s) => s.points.length >= 2);

  const [lastRun, setLastRun] = useState<CampaignRun | null>(null);
  const lastRunId = last?.runId;
  useEffect(() => {
    let live = true;
    if (lastRunId) {
      api
        .getRun(lastRunId)
        .then((r) => live && setLastRun(r))
        .catch(() => undefined);
    } else {
      setLastRun(null);
    }
    return () => {
      live = false;
    };
  }, [lastRunId]);

  return (
    <>
      <PageHead
        title="Command Center"
        sub="Fleet resilience, live alerts and what's running — the state of the estate at a glance."
      />
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-v">
            {fleet != null ? (
              <WrsPill wrs={{ wrs: fleet, level: gradeFromScore(fleet) } as WrsBreakdown} />
            ) : (
              '—'
            )}
          </div>
          <div className="kpi-k">
            Fleet resilience · {scored.length} target
            {scored.length === 1 ? '' : 's'}
          </div>
        </div>
        <Link className="kpi kpi-link" to="/theater">
          <div className="kpi-v">{running.length}</div>
          <div className="kpi-k">Runs in flight</div>
        </Link>
        <Link className="kpi kpi-link" to="/theater">
          <div className="kpi-v">
            <span className={`health-pill health-${health}`}>{health}</span>
          </div>
          <div className="kpi-k">Generator health</div>
        </Link>
        <a className="kpi kpi-link" href="#cc-alerts">
          <div className="kpi-v">{alerts.length}</div>
          <div className="kpi-k">Active alerts</div>
        </a>
      </div>
      <RoleFocus />
      <FleetOperations compact />

      {alerts.length > 0 && (
        <div id="cc-alerts" className="card" style={{ marginTop: '1rem' }}>
          <div className="card-head">
            <div className="section-title">Active alerts · from recent runs</div>
            <AiSupportButton
              title="Active alerts"
              context="the Command Center list of recent alerts (protection-regression, auto-kill, low-WRS) across the fleet."
            />
          </div>
          <ul className="alerts-list">
            {alerts.slice(0, 6).map((a) => (
              <li key={a.key} className={`alert-row alert-${a.severity}`}>
                <button
                  type="button"
                  className="alert-row-btn"
                  onClick={() => openAlert(a)}
                  title={[
                    a.at ? new Date(a.at).toLocaleString() : null,
                    a.target ? `target ${hostOf(a.target) ?? a.target}` : null,
                    a.metric ? `${a.metric.label} ${a.metric.value}` : null,
                    a.engine ? `engine ${a.engine}` : null,
                    a.durationSec != null ? `${a.durationSec}s` : null,
                    'Open the related campaign / run',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  <span className="alert-dot" aria-hidden="true" />
                  <span
                    className={`alert-sev alert-sev-${a.severity}`}
                    title={`Severity: ${a.severity}`}
                  >
                    {a.severity}
                  </span>
                  <span className="alert-title">{a.title}</span>
                  <span className="alert-detail">
                    {a.metric && <b className="alert-metric">{a.metric.value}</b>} {a.detail}
                  </span>
                  <span className="alert-go" aria-hidden="true">
                    →
                  </span>
                </button>
              </li>
            ))}
            {alerts.length > 6 && (
              <li className="alert-more">+{alerts.length - 6} more — see the 🔔 bell</li>
            )}
          </ul>
        </div>
      )}

      {impact.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="card-head">
            <div className="section-title">💥 Observed probe degradation</div>
            <AiSupportButton
              title="Observed probe degradation"
              context="the Command Center list of the test steps that broke the target — vector, breaking RPS, availability and whether it was auto-killed."
            />
          </div>
          <ul className="impact-list">
            {impact.slice(0, 8).map((im) => (
              <li key={im.runId} className="impact-row">
                <a
                  className="impact-main"
                  href={reportUrl(im.runId)}
                  target="_blank"
                  rel="noreferrer"
                  title={`${im.at ? new Date(im.at).toLocaleString() : ''} · open the run report`}
                >
                  <span className="impact-name">{shortStepName(im.name)}</span>
                  <span className="impact-chips">
                    {im.uncertain && <span className="impact-chip">uncertain attribution</span>}
                    {im.breakingRps != null && (
                      <span className="impact-chip broke">broke @ {im.breakingRps} rps</span>
                    )}
                    {im.availabilityPct < 100 && (
                      <span className="impact-chip">avail {im.availabilityPct}%</span>
                    )}
                    {im.autoKilled && <span className="impact-chip">auto-killed</span>}
                    {im.sustainedRps != null && im.sustainedRps > 0 && (
                      <span className="impact-chip muted">held {im.sustainedRps} rps</span>
                    )}
                    {im.engine && <span className="impact-chip muted">⚙ {im.engine}</span>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {running.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="section-title">Running now</div>
          {running.map((r) => (
            <div key={r.id} style={{ padding: '.3rem 0' }}>
              <b>{r.name}</b> <span className="muted">→ {r.target}</span>
            </div>
          ))}
        </div>
      )}

      {last && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="card-head">
            <div className="section-title">
              Last result · {last.name} <span className="muted">→ {last.target}</span>
            </div>
            <AiSupportButton
              title="Last result"
              context="the most recent completed assessment's headline WRS and protection-absorption breakdown for its target."
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '.6rem',
              marginBottom: '.4rem',
            }}
          >
            {last.wrs && <WrsPill wrs={last.wrs} />}
            {lastRun?.confidence?.degraded && (
              <span className="badge warn" title={lastRun.confidence.reasons.join(' ')}>
                ⚠ measurement degraded
              </span>
            )}
          </div>
          {lastRun && <AbsorptionWidget run={lastRun} />}
        </div>
      )}

      {trend && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="card-head">
            <div className="section-title">WRS trend · {trend.target}</div>
            <AiSupportButton
              title="WRS trend"
              context="the WRS resilience trend over time for the current target, with the regression flag when it drops."
            />
          </div>
          <WrsTrend points={trend.points} regression={trend.regression} />
        </div>
      )}

      <AbsorptionByShape />

      {scored.length === 0 && running.length === 0 && alerts.length === 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <p className="muted">
            No runs yet. Head to <Link to="/campaigns">Campaigns</Link> to launch your first
            assessment.
          </p>
        </div>
      )}
    </>
  );
}

/**
 * v2 Run Theater page — a focused live surface for whatever is running now. The
 * demo moment: watch the edge absorb the flood in real time. Falls back to a
 * pointer to Campaigns when nothing is in flight.
 */
/** Polls the live suite-sequence control state so the theater knows a suite is
 *  in flight even between steps (during the recovery gate, no single campaign is
 *  RUNNING). Light 3 s poll; stops on unmount.
 *
 *  While a sequence is active it also fires `onActiveTick` each poll, so the
 *  caller can refresh the campaigns list. This is essential: the app context
 *  only auto-refreshes campaigns while some campaign is RUNNING — during the
 *  recovery gate nothing is RUNNING, so without this the theater would never
 *  learn that the next step has started and would stay stuck on the gate banner
 *  until a manual navigation re-fetched. */
export function useSuiteSequences(onActiveTick?: () => void): Record<string, SuiteSequenceState> {
  const [seqs, setSeqs] = useState<Record<string, SuiteSequenceState>>({});
  const cbRef = useRef(onActiveTick);
  cbRef.current = onActiveTick;
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.suiteSequences();
        if (!alive) return;
        const s = r.sequences ?? {};
        setSeqs(s);
        // A sequence is in flight (including a gate gap) → keep campaigns fresh.
        if (Object.keys(s).length > 0) cbRef.current?.();
      } catch {
        /* transient — the next tick retries */
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return seqs;
}

/** Long curated step names read "target — playbook — shape — variant"; the
 *  theater only needs the shape onward. */
export function shortStepName(n: string): string {
  const parts = n.split('—').map((s) => s.trim());
  return parts.length > 2 ? parts.slice(2).join(' — ') : parts[parts.length - 1] || n;
}

/**
 * A one-click deep link into the ShieldTest Grafana dashboard for a given
 * observability plane. Renders nothing until a Grafana base URL is configured
 * (Settings → Observability), so the app degrades gracefully without Grafana.
 */
export function GrafanaLink({
  plane,
  label,
  target,
  campaignId,
  revisionId,
}: {
  plane: GrafanaPlane;
  label: string;
  target?: string;
  campaignId?: string;
  revisionId?: string;
}) {
  const base = getGrafanaBase();
  if (!base) return null;
  return (
    <div className="page-actions">
      <a
        className="btn btn-sm btn-ghost"
        href={grafanaDashUrl(base, plane, { target, campaignId, revisionId })}
        target="_blank"
        rel="noreferrer"
        title="Open the ShieldTest Grafana dashboard for this view"
      >
        📊 {label} ↗
      </a>
    </div>
  );
}

export function Layout() {
  const app = useApp();
  const { toasts } = app;
  const sv = app.serverVersion;
  const mismatch = isBuildMismatch(sv);
  const grafanaBase = getGrafanaBase();
  // Key the routed content by path so it re-mounts (and re-animates) on nav.
  const location = useLocation();
  const [dockOpen, setDockOpen] = useState(() => {
    try {
      return lsGet('assistantDock') !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      lsSet('assistantDock', dockOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [dockOpen]);
  // An "AI support" button on any card asks the docked assistant to open.
  useEffect(() => onAiSupport(() => setDockOpen(true)), []);
  // The docked assistant column shows on every screen except its own full page.
  const planningPage =
    app.drsWorkflow &&
    (location.pathname === '/' ||
      location.pathname.startsWith('/clients') ||
      location.pathname === '/infrastructure');
  const showDock = !planningPage && !location.pathname.startsWith('/assistant');
  const shellClass = `shell${showDock ? (dockOpen ? ' dock-open' : ' dock-min') : ''}`;
  return (
    <>
      <div className="accent-line" />
      <div className={shellClass}>
        <aside className="sidebar">
          <div className="brand-lockup sidebar-brand">
            <img className="brand-logo logo-light" src="/wedos-logo.png" alt="WEDOS" />
            <img className="brand-logo logo-dark" src="/wedos-logo-white.png" alt="WEDOS" />
            <span className="brand-tag">ShieldTest</span>
            <NotificationsBell />
          </div>
          <nav className="nav">
            {(app.drsWorkflow ? WORKSPACE_NAV : SPINE_NAV).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `nav-link nav-link-primary${isActive ? ' active' : ''}`
                }
              >
                <span className="nav-icon" aria-hidden="true">
                  {n.icon}
                </span>
                {n.label}
              </NavLink>
            ))}
            {app.drsWorkflow && (
              <>
                {app.anyRunning && (
                  <NavLink className="nav-link" to="/theater">
                    ● Active run · Run Theater
                  </NavLink>
                )}
                <details className="nav-advanced">
                  <summary>Technical tools</summary>
                  {SPINE_NAV.filter((n) => n.to !== '/' && n.to !== '/reports').map((n) => (
                    <NavLink key={n.to} className="nav-link" to={n.to}>
                      {n.label}
                    </NavLink>
                  ))}
                  <NavLink className="nav-link" to="/overview-legacy">
                    Legacy overview
                  </NavLink>
                </details>
              </>
            )}
          </nav>
          <div className="sidebar-foot">
            {grafanaBase && (
              <a
                className="nav-link nav-link-ext"
                href={grafanaBase}
                target="_blank"
                rel="noreferrer"
                title="Open the ShieldTest Grafana dashboards"
              >
                <span className="nav-icon" aria-hidden="true">
                  📈
                </span>
                Grafana ↗
              </a>
            )}
            <ThemeToggle />
            {app.authRequired && app.identity ? (
              <>
                <NavLink to="/account" className="account-chip" title="My account">
                  <span className="account-chip-avatar" aria-hidden="true">
                    {(app.identity.email || '?').split(/[@.]/)[0].slice(0, 2).toUpperCase()}
                  </span>
                  <span className="account-chip-id">
                    {app.identity.email}
                    <b>{roleLabel[app.identity.role]}</b>
                  </span>
                </NavLink>
                <button className="btn btn-sm btn-ghost" onClick={app.logout}>
                  Sign out
                </button>
              </>
            ) : (
              <NavLink to="/account" className="hint account-chip-dev" title="My account">
                Dev mode · operator <b>{app.operator || '—'}</b>
              </NavLink>
            )}
            <span
              className={`version-tag${mismatch ? ' version-tag-warn' : ''}`}
              title={
                (APP_BUILT ? `UI built ${APP_BUILT}` : 'UI') +
                (sv ? ` · server v${sv.version}+${sv.build} · ${sv.commit}` : '')
              }
            >
              {mismatch ? '⚠ ' : ''}
              {APP_VERSION_LABEL}
            </span>
          </div>
        </aside>

        <main className="main">
          {mismatch && sv && (
            <div className="build-mismatch" role="alert">
              ⚠ UI/API build mismatch — this page was built from <code>{APP_COMMIT}</code> but the
              server is serving <code>{sv.commit}</code> (v{sv.version}+{sv.build}). Hard-reload
              (Cmd/Ctrl-Shift-R); if it persists, the server needs a rebuild/restart.
            </div>
          )}
          <div className="route-fade" key={location.pathname}>
            <Outlet />
          </div>
        </main>

        {showDock &&
          (dockOpen ? (
            <aside className="assistant-dock">
              <AssistantChat variant="dock" onCollapse={() => setDockOpen(false)} />
            </aside>
          ) : (
            <aside className="assistant-dock assistant-dock-rail">
              <button
                type="button"
                className="assistant-dock-expand"
                onClick={() => setDockOpen(true)}
                title="Open the assistant"
                aria-label="Open the assistant"
              >
                💬
              </button>
            </aside>
          ))}
      </div>

      <CampaignDrawer />
      <ExecuteModal />
      <ApproveModal />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}

export function PageHead({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div className="page-head">
      <h1 className="page-title">{title}</h1>
      {sub && <p className="subtitle">{sub}</p>}
    </div>
  );
}

// ---------- Campaigns ----------
type StatusFilterId = 'all' | 'pending' | 'approved' | 'running' | 'done' | 'rejected';
const STATUS_FILTERS: {
  id: StatusFilterId;
  label: string;
  match: (c: Campaign) => boolean;
}[] = [
  { id: 'all', label: 'All', match: () => true },
  {
    id: 'pending',
    label: 'Pending',
    match: (c) => c.status === 'PENDING_APPROVAL',
  },
  { id: 'approved', label: 'Approved', match: (c) => c.status === 'APPROVED' },
  { id: 'running', label: 'Running', match: (c) => c.status === 'RUNNING' },
  {
    id: 'done',
    label: 'Done',
    match: (c) => ['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL', 'CANCELLED'].includes(c.status),
  },
  { id: 'rejected', label: 'Rejected', match: (c) => c.status === 'REJECTED' },
];
type SortId = 'recent' | 'name' | 'wrs';

const TERMINAL_STATUS: CampaignStatus[] = [
  'COMPLETED',
  'KILLED_AUTO',
  'KILLED_MANUAL',
  'REJECTED',
  'CANCELLED',
];

interface SuiteGroup {
  suiteId: string;
  suiteName: string;
  target: string;
  members: Campaign[];
  total: number;
  done: number;
  running: number;
  pending: number;
  remaining: number;
  current?: Campaign;
}

/** Group the campaign list into the suites it belongs to (newest first). */
export function groupSuites(campaigns: Campaign[]): SuiteGroup[] {
  const byId = new Map<string, Campaign[]>();
  for (const c of campaigns) {
    if (!c.suiteId) continue;
    const arr = byId.get(c.suiteId) ?? [];
    arr.push(c);
    byId.set(c.suiteId, arr);
  }
  const groups: SuiteGroup[] = [];
  for (const [suiteId, raw] of byId) {
    const members = [...raw].sort((a, b) => (a.suiteOrder ?? 0) - (b.suiteOrder ?? 0));
    const done = members.filter((m) => TERMINAL_STATUS.includes(m.status)).length;
    const running = members.filter((m) => m.status === 'RUNNING').length;
    const pending = members.filter((m) => m.status === 'PENDING_APPROVAL').length;
    const current =
      members.find((m) => m.status === 'RUNNING') ??
      members.find((m) => !TERMINAL_STATUS.includes(m.status));
    groups.push({
      suiteId,
      suiteName: members[0]?.suiteName ?? 'Assessment suite',
      target: members[0]?.target ?? '',
      members,
      total: members.length,
      done,
      running,
      pending,
      remaining: members.length - done,
      current,
    });
  }
  // Newest suite first (suiteId is time-ordered from the backend).
  return groups.sort((a, b) => b.suiteId.localeCompare(a.suiteId));
}

/** Orders grouped suite cards to honour the list's sort selection (groupSuites
 *  itself only orders by suiteId, which would ignore Name / WRS). Pure + tested. */
export function sortSuiteGroups(groups: SuiteGroup[], sort: SortId): SuiteGroup[] {
  if (sort === 'name') {
    return [...groups].sort((a, b) => a.suiteName.localeCompare(b.suiteName));
  }
  if (sort === 'wrs') {
    const worstWrs = (g: SuiteGroup): number => {
      const scored = g.members.filter((m) => m.wrs);
      return scored.length ? Math.min(...scored.map((m) => m.wrs!.wrs)) : -1;
    };
    return [...groups].sort((a, b) => worstWrs(b) - worstWrs(a));
  }
  return groups; // 'recent' — newest suite first (groupSuites default)
}

/** Strip the redundant "<suite> — " prefix from a member's name for chips. */
export function stepLabel(c: Campaign, suiteName: string): string {
  const prefix = `${suiteName} — `;
  return c.name.startsWith(prefix) ? c.name.slice(prefix.length) : c.name;
}

/**
 * One banner per in-flight assessment suite. It replaces approving every step by
 * hand: a single "Approve & run whole scenario" button approves and runs all
 * remaining steps in order (governed by the existing suite sequencer — the
 * author≠approver rule still holds), and the banner shows the sequence's live
 * progression (step k/N, current step, per-step chips) as it advances.
 */
export function SuiteRunBanner() {
  const app = useApp();
  // Two-step flow: a CISO approves, an engineer runs. Both can drive a live
  // sequence's pause/cancel controls.
  const canApprove = canDo(app.role, 'approve', app.authRequired, app.userMode, app.capabilities);
  const canExec = canDo(app.role, 'execute', app.authRequired, app.userMode, app.capabilities);
  const canRun = canApprove || canExec;
  const [busy, setBusy] = useState<string | null>(null);
  const [sequences, setSequences] = useState<Record<string, SuiteSequenceState>>({});
  const groups = useMemo(() => groupSuites(app.campaigns), [app.campaigns]);
  // The banner is only for suites that are ACTIVELY sequencing (a step in flight
  // or a live sequence between steps). A merely-pending suite lives in its group
  // card, which carries its own "Approve & run" — no duplicate banner.
  const active = groups.filter((g) => g.running > 0 || Boolean(sequences[g.suiteId]));
  const anyRemaining = groups.some((g) => g.remaining > 0);

  // Keep the list fresh for the whole sequence — between steps there may be no
  // RUNNING campaign, so the global "anyRunning" poll can lapse; poll here while
  // any suite still has steps left to run so we catch a sequence starting.
  const pullSequences = () =>
    api
      .suiteSequences()
      .then((r) => setSequences(r.sequences))
      .catch(() => undefined);
  useEffect(() => {
    if (!anyRemaining) return;
    pullSequences();
    const t = setInterval(() => {
      app.refresh();
      pullSequences();
    }, 3000);
    return () => clearInterval(t);
  }, [anyRemaining, app]);

  if (active.length === 0) return null;

  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try {
      await fn();
      app.push('success', ok);
      await Promise.all([app.refresh(), pullSequences()]);
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="suite-banners">
      {active.map((g) => {
        const pct = Math.round((g.done / Math.max(g.total, 1)) * 100);
        const seq = sequences[g.suiteId];
        const sequencing = Boolean(seq) || g.running > 0;
        const paused = seq?.paused ?? false;
        const isBusy = busy === g.suiteId;
        return (
          <div key={g.suiteId} className={`suite-banner${paused ? ' suite-banner-paused' : ''}`}>
            <div className="suite-banner-head">
              <div>
                <b>{g.suiteName}</b> <code>{g.target}</code>
                <span className="hint" style={{ marginLeft: '.5rem' }}>
                  {g.done}/{g.total} steps done
                  {g.pending ? ` · ${g.pending} awaiting approval` : ''}
                  {paused ? ' · paused' : ''}
                </span>
              </div>
              {canRun && (
                <div className="suite-banner-actions">
                  {!sequencing ? (
                    canApprove && g.pending > 0 ? (
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            g.suiteId,
                            () => api.approveSuite(g.suiteId),
                            'Assessment approved — an engineer can now run it.',
                          )
                        }
                        title="Approve every pending step of the assessment (a CISO)"
                      >
                        {isBusy ? 'Approving…' : `✓ Approve (${g.pending})`}
                      </button>
                    ) : canExec && g.pending === 0 ? (
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            g.suiteId,
                            () => {
                              if (
                                app.approvalPolicy === 'confirmation' &&
                                !window.confirm(
                                  `Run ${g.suiteName}?\n${g.members
                                    .filter(
                                      (m) =>
                                        m.status === 'APPROVED' || m.status === 'PENDING_APPROVAL',
                                    )
                                    .map(
                                      (m) =>
                                        `${m.target}: ${m.maxRps} RPS, ${m.concurrency} concurrent, ${m.maxDurationSec}s`,
                                    )
                                    .join('\n')}`,
                                )
                              )
                                return Promise.resolve();
                              return app.approvalPolicy === 'confirmation'
                                ? api.runSuite(g.suiteId, true)
                                : api.runSuite(g.suiteId);
                            },
                            'Assessment started — approved steps run in order.',
                          )
                        }
                        title="Run the approved steps of the assessment in order"
                      >
                        {isBusy ? 'Starting…' : `▶ Run assessment (${g.remaining})`}
                      </button>
                    ) : null
                  ) : (
                    <>
                      {paused ? (
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={isBusy}
                          onClick={() =>
                            act(g.suiteId, () => api.resumeSuite(g.suiteId), 'Assessment resumed.')
                          }
                          title="Resume the sequence"
                        >
                          ▶ Resume
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm"
                          disabled={isBusy}
                          onClick={() =>
                            act(
                              g.suiteId,
                              () => api.pauseSuite(g.suiteId),
                              'Assessment will pause after the current step.',
                            )
                          }
                          title="Pause: the current step finishes, the next won't start until you resume"
                        >
                          ⏸ Pause
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            g.suiteId,
                            () => api.cancelSuite(g.suiteId),
                            'Assessment cancelled — step in flight stopped.',
                          )
                        }
                        title="Cancel the sequence and kill the step in flight (remaining steps stay approved, not run)"
                      >
                        ✕ Cancel
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="live-bar" aria-label="Assessment progress">
              <div className="live-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="suite-banner-status">
              {paused ? (
                <span className="hint">⏸ Paused — holding before the next step.</span>
              ) : g.running > 0 && g.current ? (
                <span className="hint">
                  <span className="spin" /> Running step {(g.current.suiteOrder ?? 0) + 1}/{g.total}
                  : <b>{stepLabel(g.current, g.suiteName)}</b>
                </span>
              ) : sequencing ? (
                <span className="hint">
                  <span className="spin" /> Advancing the sequence…
                </span>
              ) : g.current ? (
                <span className="hint">
                  Next: step {(g.current.suiteOrder ?? 0) + 1}/{g.total}{' '}
                  <b>{stepLabel(g.current, g.suiteName)}</b>
                </span>
              ) : null}
            </div>
            <SuiteStepChips
              steps={g.members.map((m) => ({
                key: m.id,
                order: m.suiteOrder ?? 0,
                label: stepLabel(m, g.suiteName),
                wrs: m.wrs ? `${m.wrs.wrs} ${m.wrs.level}` : undefined,
                status: m.status,
              }))}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Human local date-time, or '—' when absent/unparseable. */
function fmtWhen(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Compact duration from seconds (75 → "1m 15s", 3900 → "1h 5m"). */
export function fmtDur(sec?: number): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface SuiteTiming {
  start?: string;
  end?: string;
  wallSec?: number;
  runSec: number;
}

/** Start (earliest step), end (latest finish), wall-clock span and on-target time. */
export function suiteTiming(members: Campaign[]): SuiteTiming {
  const starts = members.map((m) => m.startedAt ?? m.createdAt).filter(Boolean) as string[];
  const ends = members.map((m) => m.finishedAt).filter(Boolean) as string[];
  const start = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : undefined;
  const end = ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : undefined;
  const wallSec =
    start && end ? (new Date(end).getTime() - new Date(start).getTime()) / 1000 : undefined;
  const runSec = members.reduce((s, m) => s + (m.durationSec ?? 0), 0);
  return { start, end, wallSec, runSec };
}

/** Aggregate WRS across scored members: average + worst (min) with its level. */
export function suiteWrs(members: Campaign[]): {
  avg: number;
  min: number;
  level: WrsBreakdown['level'];
  scored: number;
} | null {
  const scored = members.filter((m) => m.wrs);
  if (!scored.length) return null;
  const vals = scored.map((m) => m.wrs!.wrs);
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  let worst = scored[0];
  for (const m of scored) if (m.wrs!.wrs < worst.wrs!.wrs) worst = m;
  return {
    avg,
    min: worst.wrs!.wrs,
    level: worst.wrs!.level,
    scored: scored.length,
  };
}

/**
 * One collapsible card per assessment suite: the steps of a scenario grouped
 * under a header that carries the suite's target, aggregate WRS, timing (start →
 * end, elapsed, on-target time) and a whole-suite archive + assessment report.
 * Collapsed shows a compact step strip; expanded mounts the full per-step cards.
 */
/** One compact line inside an expanded suite — label, status, spec, WRS, and the
 *  few inline controls that matter (kill in-flight, report). Click opens the
 *  full detail drawer, so per-step approve/run/cancel stay one click away
 *  without 4 buttons on every row. */
function SuiteStepRow({
  m,
  suiteName,
  suiteRunning,
}: {
  m: Campaign;
  suiteName: string;
  suiteRunning?: boolean;
}) {
  const app = useApp();
  const spec = `${m.maxRps} rps · ${m.maxDurationSec}s${
    m.vector !== 'http-get' ? ` · ${m.vector.replace('http-', '')}` : ''
  }`;
  // An APPROVED step whose suite sequence has stopped (target went down, an
  // auto-kill halted it) can be launched here by an engineer — the two-step flow
  // (a CISO approves, an engineer runs) applied to a single remaining step, so a
  // stalled suite is never a dead end. Hidden while the sequence is live (the
  // backend refuses a manual run then anyway).
  const canRelaunch =
    (m.status === 'APPROVED' ||
      (app.approvalPolicy === 'confirmation' && m.status === 'PENDING_APPROVAL')) &&
    !suiteRunning &&
    canDo(app.role, 'execute', app.authRequired, app.userMode, app.capabilities);
  return (
    <div className={`suite-step-row ${SUITE_STEP_CLASS[m.status] ?? ''}`}>
      <button className="ssr-main" onClick={() => app.openDetail(m)} title="Open step details">
        <span className="ssr-n">{(m.suiteOrder ?? 0) + 1}</span>
        <span className="ssr-name">{stepLabel(m, suiteName)}</span>
        <StatusBadge status={m.status} />
        {m.wrs && <WrsPill wrs={m.wrs} />}
        <span className="ssr-spec">{spec}</span>
      </button>
      <div className="ssr-actions">
        {canRelaunch && (
          <button
            className="btn btn-sm btn-primary"
            onClick={() =>
              app.approvalPolicy === 'confirmation' ? app.setConfirmExec(m) : app.execute(m)
            }
            title="Launch this approved step (the sequence stopped — run the remaining step)"
          >
            ▶ Run step
          </button>
        )}
        {m.status === 'RUNNING' &&
          canDo(app.role, 'kill', app.authRequired, app.userMode, app.capabilities) && (
            <button className="btn btn-sm btn-danger" onClick={() => app.kill(m)}>
              Kill
            </button>
          )}
        {m.runId && (
          <a
            className="btn btn-sm btn-ghost"
            href={reportUrl(m.runId)}
            target="_blank"
            rel="noreferrer"
          >
            Report ↗
          </a>
        )}
      </div>
    </div>
  );
}

function SuiteGroupCard({ g }: { g: SuiteGroup }) {
  const app = useApp();
  const canArchive = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  // Two-step flow: a CISO approves the scenario, then an engineer runs it.
  const canApprove = canDo(app.role, 'approve', app.authRequired, app.userMode, app.capabilities);
  const canExec = canDo(app.role, 'execute', app.authRequired, app.userMode, app.capabilities);
  const t = useMemo(() => suiteTiming(g.members), [g.members]);
  const agg = useMemo(() => suiteWrs(g.members), [g.members]);
  const active = g.remaining > 0;
  const approvedRemaining = Math.max(0, g.remaining - g.pending); // approved, not yet run
  const sequencing = g.running > 0; // a step is in flight → the live banner drives it
  const [open, setOpen] = useState(false);
  const allArchived = g.members.every((m) => m.archived);
  const busy = app.busy[g.suiteId];
  const scored = agg ? `${agg.scored}/${g.total} scored` : 'not scored';
  const [localBusy, setLocalBusy] = useState(false);
  // Approve / Reject modal (batches over the pending steps) — the suite-level
  // counterpart to a single campaign's Approve/Reject, so both offer the same
  // governance actions.
  const [decideOpen, setDecideOpen] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [reason, setReason] = useState('');
  const closeDecide = () => {
    setDecideOpen(false);
    setReason('');
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setLocalBusy(true);
    try {
      await fn();
      app.push('success', ok);
      app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setLocalBusy(false);
    }
  };
  const approveScenario = async () => {
    await act(
      () => api.approveSuite(g.suiteId),
      'Assessment approved — an engineer can now run it.',
    );
    closeDecide();
  };
  const rejectScenario = async () => {
    await act(() => api.rejectSuite(g.suiteId, reason.trim()), 'Assessment rejected.');
    closeDecide();
  };
  const runScenario = () =>
    act(
      () =>
        app.approvalPolicy === 'confirmation'
          ? api.runSuite(g.suiteId, true)
          : api.runSuite(g.suiteId),
      'Assessment started — confirmed steps run in order.',
    );

  return (
    <div className={`suite-group${allArchived ? ' is-archived' : ''}`}>
      <div className="suite-group-head">
        <button
          type="button"
          className="suite-group-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="suite-group-name">📋 {g.suiteName}</span>
        </button>
        <span className={`chip-count suite-progress${active ? ' is-active' : ''}`}>
          {g.done}/{g.total} steps
        </span>
        {agg && (
          <span className={`wrs-pill ${wrsClass(agg.level)}`} title={`Average WRS · ${scored}`}>
            avg {agg.avg} · worst {agg.min} {agg.level}
          </span>
        )}
        <div className="suite-group-actions">
          {app.approvalPolicy !== 'confirmation' && canApprove && g.pending > 0 && !sequencing && (
            <button
              className="btn btn-sm btn-primary"
              disabled={localBusy}
              onClick={() => setDecideOpen(true)}
              title="Approve or reject every pending step of the assessment. An engineer then runs it."
            >
              {localBusy ? <span className="spin" /> : null}Approve / Reject ({g.pending})
            </button>
          )}
          {canExec &&
            (app.approvalPolicy === 'confirmation'
              ? g.remaining > 0
              : g.pending === 0 && approvedRemaining > 0) &&
            !sequencing && (
              <button
                className="btn btn-sm btn-primary"
                disabled={localBusy}
                onClick={() =>
                  app.approvalPolicy === 'confirmation' ? setConfirmRun(true) : runScenario()
                }
                title="Run the approved steps of the assessment in order"
              >
                {localBusy ? <span className="spin" /> : null}▶ Run assessment (
                {app.approvalPolicy === 'confirmation' ? g.remaining : approvedRemaining})
              </button>
            )}
          {g.done > 0 && (
            <a
              className="btn btn-sm btn-ghost"
              href={suiteReportUrl(g.suiteId)}
              target="_blank"
              rel="noreferrer"
            >
              Report ↗
            </a>
          )}
          {canArchive && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={busy || sequencing}
              onClick={() => app.archiveSuite(g.suiteId, g.suiteName, !allArchived)}
              title={
                sequencing
                  ? 'Pause or cancel the running sequence before archiving'
                  : allArchived
                    ? 'Restore the whole suite to the active list'
                    : 'Archive the whole suite (hide from the default list)'
              }
            >
              {busy ? <span className="spin" /> : null}
              {allArchived ? 'Restore' : 'Archive'}
            </button>
          )}
        </div>
      </div>
      <div className="suite-group-meta">
        <span>
          Target: <code>{g.target}</code>
        </span>
        {active && <span className="hint">{g.remaining} remaining</span>}
        <span title="First step start → last step end">
          🕒 {fmtWhen(t.start)} → {fmtWhen(t.end)}
        </span>
        {t.wallSec != null && (
          <span title="Wall-clock span, first start to last finish">
            ⏱ {fmtDur(t.wallSec)} elapsed
          </span>
        )}
        {t.runSec > 0 && (
          <span title="Sum of per-step run durations">Σ {fmtDur(t.runSec)} on target</span>
        )}
      </div>
      {open ? (
        <div className="suite-group-members">
          {g.members.map((m) => (
            <SuiteStepRow key={m.id} m={m} suiteName={g.suiteName} suiteRunning={sequencing} />
          ))}
        </div>
      ) : sequencing ? (
        // The live banner above already shows the step-by-step progression for a
        // suite in flight — don't repeat the chip strip here (it read as the
        // detail appearing twice). Expand the card for the per-step rows.
        <div className="suite-steps suite-steps-live">
          <span className="hint">▲ Live step-by-step progress is shown in the banner above.</span>
        </div>
      ) : (
        <SuiteStepChips
          steps={g.members.map((m) => ({
            key: m.id,
            order: m.suiteOrder ?? 0,
            label: stepLabel(m, g.suiteName),
            wrs: m.wrs ? `${m.wrs.wrs} ${m.wrs.level}` : undefined,
            status: m.status,
          }))}
        />
      )}
      {confirmRun && (
        <Modal label="Confirm assessment" onClose={() => setConfirmRun(false)}>
          <h3>Confirm assessment — {g.suiteName}</h3>
          <p>Run the following steps in order. The kill switch stays available.</p>
          <ul>
            {g.members
              .filter((m) => m.status === 'PENDING_APPROVAL' || m.status === 'APPROVED')
              .map((m) => (
                <li key={m.id}>
                  {m.target}: {m.maxRps} RPS, {m.concurrency} concurrent, {m.maxDurationSec}s
                </li>
              ))}
          </ul>
          <div className="btn-row">
            <button className="btn" onClick={() => setConfirmRun(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={localBusy}
              onClick={() => {
                setConfirmRun(false);
                void runScenario();
              }}
            >
              Run now
            </button>
          </div>
        </Modal>
      )}
      {decideOpen && (
        <Modal label="Approve or reject assessment" onClose={closeDecide}>
          <h3>Approve or reject — {g.suiteName}</h3>
          <p className="hint">
            This applies to all {g.pending} pending step(s) of the assessment. A step you authored
            is left for a different approver (separation of duties).
          </p>
          <div className="field">
            <label>Reason (required for rejection)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="btn-row">
            <button className="btn" onClick={closeDecide}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={localBusy || !reason.trim()}
              onClick={rejectScenario}
            >
              Reject ({g.pending})
            </button>
            <button className="btn btn-primary" disabled={localBusy} onClick={approveScenario}>
              Approve ({g.pending})
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The "Launch" surface of the Campaigns workspace: the guided wizard (or the
 *  classic form when a preset is queued from the guide). */
export function CampaignLaunch() {
  const [launchParams] = useSearchParams();
  const fleetLaunch = launchParams.get('engine') === 'fleet';
  const app = useApp();
  const canCreate = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  const [showForm, setShowForm] = useState(fleetLaunch);
  // Open the form automatically when a preset is queued from the guide, or a
  // replay seed is queued from a completed run's conclusions.
  useEffect(() => {
    if (app.draftPreset || app.draftCampaign) setShowForm(true);
  }, [app.draftPreset, app.draftCampaign]);
  const closeForm = () => {
    app.clearDraftCampaign();
    app.clearDraftPreset();
    setShowForm(false);
  };

  if (!canCreate) {
    return (
      <p className="hint">
        Read-only access — browse the Templates and Plan tabs; an engineer creates and launches
        campaigns (a CISO approves them).
      </p>
    );
  }
  // A single queued seed, whatever queued it: a completed run's countermeasures
  // (replay), or a preset from the Guide (turned into a seed here). Both feed the
  // form through the same `initial` prop — no in-form effect, no self-clearing.
  const seed =
    app.draftCampaign ?? (app.draftPreset ? presetSeed(app.draftPreset, app.agents) : null);
  if (app.drsWorkflow && !seed?.drsProfileId)
    return (
      <DrsCatalogPanel
        target={launchParams.get('target') ?? ''}
        deviceIds={launchParams.get('devices')?.split(',').filter(Boolean)}
      />
    );
  return (
    <>
      {!showForm && (
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            ＋ New campaign
          </button>
          <span className="hint">
            Recon-first: give a target, we profile it, then propose the configuration. Prefer
            templates? Browse the <b>Templates</b> tab.
          </span>
        </div>
      )}
      {showForm &&
        (seed ? (
          <NewCampaignForm key={JSON.stringify(seed)} initial={seed} onDone={closeForm} />
        ) : (
          // The single recon-first creation flow.
          <ReconFirstCreate
            onDone={closeForm}
            preferredAgent={fleetLaunch ? 'fleet' : undefined}
            preferredDevices={launchParams.get('devices')?.split(',').filter(Boolean)}
            initialTarget={launchParams.get('target') ?? undefined}
          />
        ))}
    </>
  );
}

/** The persistent campaign list (suites grouped above standalone) with filters —
 *  always shown at the foot of the Campaigns workspace, under the active tab. */
// ---------- Compact, sortable campaign table (rows expand to the full card) ----------
export type CampaignSortKey = 'created' | 'name' | 'wrs' | 'status';

export interface CampaignRow {
  key: string;
  kind: 'suite' | 'campaign';
  name: string;
  statusLabel: string;
  statusRank: number;
  wrs: number | null;
  wrsLevel: WrsBreakdown['level'] | null;
  target: string;
  createdMs: number;
  suite?: SuiteGroup;
  campaign?: Campaign;
}

const CAMPAIGN_STATUS_RANK: Record<string, number> = {
  RUNNING: 0,
  PENDING_APPROVAL: 1,
  APPROVED: 2,
  COMPLETED: 3,
  KILLED_AUTO: 4,
  KILLED_MANUAL: 4,
  REJECTED: 5,
  CANCELLED: 6,
};

function suiteRowStatus(g: SuiteGroup): { label: string; rank: number } {
  if (g.running > 0) return { label: `Running ${g.done}/${g.total}`, rank: 0 };
  if (g.pending > 0) return { label: `Pending ${g.done}/${g.total}`, rank: 1 };
  return { label: `Done ${g.done}/${g.total}`, rank: 3 };
}

/** Flatten suites + standalone campaigns into one unified row model. Pure. */
export function toCampaignRows(suites: SuiteGroup[], standalone: Campaign[]): CampaignRow[] {
  const rows: CampaignRow[] = [];
  for (const g of suites) {
    const sw = suiteWrs(g.members);
    const st = suiteRowStatus(g);
    const createdMs = g.members.reduce(
      (mx, m) => Math.max(mx, m.createdAt ? Date.parse(m.createdAt) || 0 : 0),
      0,
    );
    rows.push({
      key: `s:${g.suiteId}`,
      kind: 'suite',
      name: g.suiteName,
      statusLabel: st.label,
      statusRank: st.rank,
      wrs: sw ? sw.min : null, // the suite's WORST step (the honest headline)
      wrsLevel: sw ? sw.level : null,
      target: g.target,
      createdMs,
      suite: g,
    });
  }
  for (const c of standalone) {
    rows.push({
      key: `c:${c.id}`,
      kind: 'campaign',
      name: c.name,
      statusLabel: c.status,
      statusRank: CAMPAIGN_STATUS_RANK[c.status] ?? 9,
      wrs: c.wrs ? c.wrs.wrs : null,
      wrsLevel: c.wrs ? c.wrs.level : null,
      target: c.target,
      createdMs: c.createdAt ? Date.parse(c.createdAt) || 0 : 0,
      campaign: c,
    });
  }
  return rows;
}

/** Order rows by a column, honouring the direction. Pure, so it is unit-tested. */
export function sortCampaignRows(
  rows: CampaignRow[],
  key: CampaignSortKey,
  dir: 'asc' | 'desc',
): CampaignRow[] {
  const cmp = (a: CampaignRow, b: CampaignRow): number => {
    switch (key) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'wrs':
        return (a.wrs ?? -1) - (b.wrs ?? -1);
      case 'status':
        return a.statusRank - b.statusRank || b.createdMs - a.createdMs;
      case 'created':
      default:
        return a.createdMs - b.createdMs;
    }
  };
  return [...rows].sort((a, b) => (dir === 'asc' ? cmp(a, b) : -cmp(a, b)));
}

function fmtRowDate(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A composite (suite) row's status, rendered in the SAME badge language as a
 *  single campaign's StatusBadge (so the two row kinds read as one family),
 *  plus a slim progress bar since a suite is multi-step. */
function SuiteStatusCell({
  label,
  rank,
  done,
  total,
}: {
  label: string;
  rank: number;
  done: number;
  total: number;
}) {
  const phase = rank === 0 ? 'RUNNING' : rank === 1 ? 'PENDING_APPROVAL' : 'COMPLETED';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`ct-suite-status phase-${phase}`}>
      <span className={`badge badge-${phase}`}>{label}</span>
      <span className="ct-progress" aria-hidden="true">
        <span className="ct-progress-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function CampaignTable({ rows }: { rows: CampaignRow[] }) {
  const [sortKey, setSortKey] = useState<CampaignSortKey>('created');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => sortCampaignRows(rows, sortKey, dir), [rows, sortKey, dir]);
  const toggleSort = (k: CampaignSortKey) => {
    if (k === sortKey) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setDir(k === 'name' || k === 'status' ? 'asc' : 'desc'); // names/status asc, wrs/date desc
    }
  };
  const toggleOpen = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const ariaSort = (k: CampaignSortKey): 'ascending' | 'descending' | 'none' =>
    sortKey === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = (k: CampaignSortKey) => (sortKey === k ? (dir === 'asc' ? ' ▲' : ' ▼') : '');
  const SortTh = ({ k, label, cls }: { k: CampaignSortKey; label: string; cls?: string }) => (
    <th className={`ct-th${cls ? ' ' + cls : ''}`} aria-sort={ariaSort(k)}>
      <button type="button" className="ct-sort" onClick={() => toggleSort(k)}>
        {label}
        {arrow(k)}
      </button>
    </th>
  );

  return (
    <div className="ct-wrap">
      <table className="campaign-table">
        <thead>
          <tr>
            <th className="ct-th-exp" aria-hidden="true"></th>
            <SortTh k="name" label="Name" />
            <SortTh k="status" label="Status" />
            <SortTh k="wrs" label="WRS" cls="ct-num" />
            <th className="ct-th">Target</th>
            <th className="ct-th">Execution</th>
            <SortTh k="created" label="Created" cls="ct-created" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const isOpen = open.has(r.key);
            return (
              <Fragment key={r.key}>
                <tr
                  className={`ct-row${isOpen ? ' ct-open' : ''}`}
                  onClick={() => toggleOpen(r.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleOpen(r.key);
                    }
                  }}
                  tabIndex={0}
                  aria-expanded={isOpen}
                >
                  <td className="ct-exp" aria-hidden="true">
                    {isOpen ? '▾' : '▸'}
                  </td>
                  <td className="ct-name">
                    <span className={`ct-kind ct-kind-${r.kind}`} aria-hidden="true">
                      {r.kind === 'suite' ? '📁' : '⚡'}
                    </span>
                    <span className="ct-name-txt">{r.name}</span>
                    {r.suite && <span className="ct-steps"> · {r.suite.total} steps</span>}
                  </td>
                  <td>
                    {r.kind === 'campaign' && r.campaign ? (
                      <StatusBadge status={r.campaign.status} />
                    ) : r.suite ? (
                      <SuiteStatusCell
                        label={r.statusLabel}
                        rank={r.statusRank}
                        done={r.suite.done}
                        total={r.suite.total}
                      />
                    ) : (
                      <span className="ct-suite-status">{r.statusLabel}</span>
                    )}
                  </td>
                  <td className="ct-num">
                    {r.wrs != null && r.wrsLevel ? (
                      <span className={`wrs-pill ${wrsClass(r.wrsLevel)}`}>
                        {r.wrs} {r.wrsLevel}
                      </span>
                    ) : (
                      <span className="hint">—</span>
                    )}
                  </td>
                  <td className="ct-target" title={r.target}>
                    {r.campaign?.drsMode === 'engine-validation'
                      ? 'Virtual scope'
                      : (hostOf(r.target) ?? r.target)}
                  </td>
                  <td>
                    {r.campaign?.drsMode === 'engine-validation'
                      ? 'Simulation · no traffic'
                      : r.campaign?.agent === 'fleet'
                        ? `${r.campaign.drsProfileId ? 'DRS · ' : ''}IoT Fleet · ${r.campaign.fleetDeviceIds?.length ?? 3} agents`
                        : r.kind === 'suite'
                          ? 'Assessment suite'
                          : `Local generator · ${r.campaign?.agent || 'server default'}`}
                  </td>
                  <td className="ct-created">{fmtRowDate(r.createdMs)}</td>
                </tr>
                {isOpen && (
                  <tr className="ct-detail">
                    <td colSpan={7}>
                      {r.kind === 'suite' && r.suite ? (
                        <SuiteGroupCard g={r.suite} />
                      ) : r.campaign ? (
                        <CampaignCard c={r.campaign} />
                      ) : null}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CampaignList() {
  const app = useApp();
  // Pre-fill the search from ?q= so a "Protected zones" card deep-links straight
  // to that host's campaigns.
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState<StatusFilterId>('all');
  const [showArchived, setShowArchived] = useState(false);

  const archivedCount = useMemo(
    () => app.campaigns.filter((c) => c.archived).length,
    [app.campaigns],
  );

  const filtered = useMemo(() => {
    const matchStatus = STATUS_FILTERS.find((f) => f.id === status)!.match;
    let list = app.campaigns.filter((c) => showArchived || !c.archived).filter(matchStatus);
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter(
        (c) => c.name.toLowerCase().includes(term) || c.target.toLowerCase().includes(term),
      );
    }
    return list;
  }, [app.campaigns, status, q, showArchived]);

  // Everything — suites AND standalone campaigns — is one compact, column-sortable
  // table; a row expands to its detail (a suite's step card, a campaign's card) on
  // demand. Suites are NOT big always-open cards.
  const suiteGroups = useMemo(() => groupSuites(filtered), [filtered]);
  const standalone = useMemo(() => filtered.filter((c) => !c.suiteId), [filtered]);
  const rows = useMemo(() => toCampaignRows(suiteGroups, standalone), [suiteGroups, standalone]);

  const hasCampaigns = app.campaigns.length > 0;

  return (
    <>
      <div className="card-head">
        <h2 className="section-title">
          Campaign list <span className="hint">({filtered.length})</span>
          {app.anyRunning && <span className="hint"> · auto-refreshing…</span>}
        </h2>
        <AiSupportButton
          title="Campaign list"
          context="the campaign list with its current status/target/WRS filters — recent and in-flight resilience campaigns and suites."
        />
      </div>

      {hasCampaigns && (
        <div className="filter-bar">
          <div className="filter-chips">
            {STATUS_FILTERS.map((f) => {
              const n = app.campaigns.filter(
                (c) => (showArchived || !c.archived) && f.match(c),
              ).length;
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`chip${status === f.id ? ' chip-active' : ''}`}
                  onClick={() => setStatus(f.id)}
                >
                  {f.label} <span className="chip-count">{n}</span>
                </button>
              );
            })}
          </div>
          <div className="filter-tools">
            <input
              className="filter-search"
              aria-label="Search campaigns by name or target"
              type="search"
              placeholder="Search name or target…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {archivedCount > 0 && (
              <label className="archived-toggle" title="Include archived campaigns">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                Archived <span className="chip-count">{archivedCount}</span>
              </label>
            )}
          </div>
        </div>
      )}

      <div className="campaigns">
        {!hasCampaigns && <div className="empty">No campaigns yet.</div>}
        {hasCampaigns && filtered.length === 0 && (
          <div className="empty">No campaigns match your filters.</div>
        )}
        {rows.length > 0 && <CampaignTable rows={rows} />}
      </div>
    </>
  );
}

// ---------- Reports ----------
const SUITE_STEP_CLASS: Record<string, string> = {
  RUNNING: 'step-running',
  COMPLETED: 'step-done',
  KILLED_AUTO: 'step-killed',
  KILLED_MANUAL: 'step-killed',
  REJECTED: 'step-killed',
  CANCELLED: 'step-pending',
  APPROVED: 'step-approved',
  PENDING_APPROVAL: 'step-pending',
};

/** The step chips of an assessment suite (order · label · WRS), coloured by status.
 *  Shared by SuiteRunBanner and SuiteGroupCard. */
function SuiteStepChips({
  steps,
}: {
  steps: {
    key: string;
    order: number;
    label: string;
    wrs?: string;
    status: string;
  }[];
}) {
  return (
    <div className="suite-steps">
      {steps.map((s) => (
        <span
          key={s.key}
          className={`chip-xs ${SUITE_STEP_CLASS[s.status] ?? ''}`}
          title={s.status}
        >
          {s.order + 1}. {s.label}
          {s.wrs ? ` · ${s.wrs}` : ''}
        </span>
      ))}
    </div>
  );
}

const GAP_PILL: Record<Priority, string> = {
  high: 'gap-high',
  medium: 'gap-med',
  low: 'gap-low',
};
const STATUS_OPTIONS: ControlStatus[] = ['unknown', 'present', 'partial', 'absent'];

/**
 * Protection-gap planner (RPT-05): declare the target's WEDOS controls and get a
 * prioritised plan of which bounded playbook lines to replay first (the front
 * half of the tune-and-replay loop), plus the attestation-only lines. Analytical
 * only — it orders existing bounded tests, it does not synthesise attacks.
 */
const NET_STATUS_META: Record<string, { cls: string; icon: string; label: string }> = {
  absorbed: { cls: 'net-ok', icon: '✓', label: 'absorbed' },
  gap: { cls: 'net-gap', icon: '✕', label: 'gap' },
  uncovered: { cls: 'net-none', icon: '–', label: 'no lab evidence' },
};

/**
 * Network layer (from the closed class-C lab) — the L3/4 half of a full-stack
 * plan. Shows the lab's per-scenario verdicts as a DRS 3→5 ladder (mirroring the
 * L7 ladder below), so the plan spans the whole stack: the lab owns the network
 * tiers the bounded L7 tests can never reach.
 */
function NetworkLadderPanel() {
  const [ladder, setLadder] = useState<NetworkLadder | null>(null);
  useEffect(() => {
    api
      .networkLadder()
      .then(setLadder)
      .catch(() => undefined);
  }, []);
  if (!ladder) return null;
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="card-head">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          Network layer <span className="hint">— from the lab (class C, L3/4)</span>
        </h2>
        <AiSupportButton
          title="Network layer (lab DRS ladder)"
          context="the class-C L3/4 lab ladder — which network vectors the edge absorbed per DRS tier, and where lab verdicts exist."
        />
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        The closed synthetic lab reports whether the edge absorbs each network vector — the L3/4
        tiers the bounded L7 tests below can never reach. Together they read as one full-stack DRS
        ladder. <b>{ladder.covered}</b>/<b>{ladder.total}</b> vectors have a lab verdict.
      </p>
      {ladder.covered === 0 ? (
        <div className="gap-break gap-break-ok" style={{ marginTop: 0 }}>
          No lab evidence yet — the lab is feeding this. Network vectors will light up as class-C
          verdicts arrive.
        </div>
      ) : (
        <>
          {ladder.weakest ? (
            <div className="gap-break">
              <b>
                Network weakest link — DRS{ladder.weakest.drs}: {ladder.weakest.title}.
              </b>{' '}
              The lab found a gap here; the L3/4 foundation breaks before the L7 tiers matter.
            </div>
          ) : (
            <div className="gap-break gap-break-ok">
              <b>No network gap on the lab ladder.</b> The edge absorbed every covered L3/4 vector —
              the plan can focus on the L7 tiers below.
            </div>
          )}
          {ladder.tiers.map((t) => (
            <div key={t.drs} className="net-tier">
              <span className="net-tier-n">DRS {t.drs}</span>
              <div className="net-vectors">
                {t.vectors.map((v) => {
                  const m = NET_STATUS_META[v.status];
                  return (
                    <span
                      key={v.id}
                      className={`net-vec ${m.cls}`}
                      title={`${v.proto} · ${m.label}${v.outcome ? ` — ${v.outcome}` : ''}${
                        v.source ? ` (${v.source})` : ''
                      }`}
                    >
                      <span className="net-vec-i" aria-hidden="true">
                        {m.icon}
                      </span>{' '}
                      {v.title}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function GapPlannerSection() {
  const app = useApp();
  const navigate = useNavigate();
  const [target, setTarget] = useState('bank.cz');
  const [profile, setProfile] = useState<ProtectionProfile>({});
  const [analysis, setAnalysis] = useState<GapAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const [inferring, setInferring] = useState(false);
  const [provenance, setProvenance] = useState<InferredProfile['provenance']>({});

  const setControl = (key: ControlKey, status: ControlStatus) =>
    setProfile((p) => ({ ...p, [key]: status }));

  // Seed the control profile from evidence (recon + prior runs + class-C lab)
  // instead of declaring every control by hand; the operator then reviews it.
  const infer = async () => {
    setInferring(true);
    try {
      const r = await api.inferProfile(target.trim() || undefined);
      setProfile((p) => ({ ...p, ...r.profile }));
      setProvenance(r.provenance);
      const n = Object.keys(r.profile).length;
      app.push(
        n ? 'success' : 'info',
        n
          ? `Seeded ${n} control${n === 1 ? '' : 's'} from evidence — review, then analyze.`
          : 'No evidence yet for this target (recon, prior runs or lab). Declare controls by hand.',
      );
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setInferring(false);
    }
  };

  const analyze = async () => {
    setBusy(true);
    try {
      setAnalysis(await api.gapAnalysis(profile, target.trim() || undefined));
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Lines worth testing: the prioritised (high/medium) replayable lines, in
  // ladder order; fall back to every replayable line if nothing is prioritised.
  const planPicks = useMemo(() => {
    if (!analysis) return [];
    const replayable = analysis.plan.filter((p) => p.templateId);
    const prioritised = replayable.filter((p) => p.priority !== 'low');
    const chosen = prioritised.length ? prioritised : replayable;
    return [...new Set(chosen.map((p) => p.templateId as string))];
  }, [analysis]);

  // The whole point of the planner: turn the recommended lines into a runnable,
  // governed campaign in one click — composed as a suite (or a single line).
  const createFromPlan = async () => {
    if (planPicks.length === 0) return;
    const host = target.trim();
    const targetUrl = defaultTargetUrl(host);
    setCreating(true);
    try {
      const name = `Plan — ${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
      const r =
        planPicks.length >= 2
          ? await api.composeSuite({
              playbookIds: planPicks,
              name,
              target: targetUrl,
            })
          : await api.instantiatePlaybook(planPicks[0], { target: targetUrl });
      app.push(
        'success',
        `${planPicks.length >= 2 ? 'Assessment' : 'Campaign'} created — ${r.campaigns.length} step${r.campaigns.length === 1 ? '' : 's'} from the plan (pending approval).`,
      );
      await app.refresh();
      navigate('/campaigns?tab=launch');
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <p className="guide-lead">
        Plan turns what we <b>know</b> about the target's defenses into the <b>campaign</b> that
        probes its weakest links. ① Seed the controls from evidence (recon, prior runs, the lab), ②
        read the full-stack DRS ladder to see where it likely breaks, ③ create the campaign that
        replays those lines — one governed click.
      </p>
      <NetworkLadderPanel />
      <h2 className="section-title">
        ② Where it breaks — L7 <span className="hint">protection-gap ladder</span>
      </h2>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <p className="hint" style={{ marginTop: 0 }}>
          <b>① Seed</b> the target's WEDOS controls from evidence (or declare them), then{' '}
          <b>Analyze</b> to get the prioritised ladder of bounded <code>pretest-cra-l7</code> lines
          and the predicted break point. <b>③ Create the campaign</b> from the plan to replay those
          lines. It only orders existing bounded tests against the authorized target — it never
          synthesises attacks or relaxes a cap.
        </p>
        <label className="field" style={{ maxWidth: '22rem' }}>
          <span>Target</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="bank.cz" />
        </label>
        <div className="gap-controls">
          {GAP_CONTROLS.map((c) => {
            const ev = provenance[c.key];
            return (
              <Fragment key={c.key}>
                <span className="gap-ctl-label">{c.label}</span>
                <select
                  value={profile[c.key] ?? 'unknown'}
                  onChange={(e) => setControl(c.key, e.target.value as ControlStatus)}
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {ev && ev.length > 0 ? (
                  <span
                    className={`gap-ctl-src src-${ev[0].source}`}
                    title={ev.map((e) => `${e.source}: ${e.note}`).join('\n')}
                  >
                    {[...new Set(ev.map((e) => e.source))].join(' · ')}
                  </span>
                ) : (
                  <span />
                )}
              </Fragment>
            );
          })}
        </div>
        <div className="row">
          <button className="btn" onClick={infer} disabled={inferring || busy}>
            {inferring ? 'Inferring…' : '✨ Infer from evidence'}
          </button>
          <button className="btn btn-primary" onClick={analyze} disabled={busy || inferring}>
            {busy ? 'Analyzing…' : 'Analyze gaps'}
          </button>
        </div>

        {analysis && (
          <div style={{ marginTop: '1rem' }}>
            {planPicks.length > 0 && (
              <div className="plan-cta">
                <div>
                  <b>Recommended assessment</b> — {planPicks.length} prioritised bounded step
                  {planPicks.length === 1 ? '' : 's'}, in ladder order, composed into one governed
                  assessment against <code>{target.trim()}</code>. It still goes through approval.
                </div>
                <button
                  className="btn btn-primary"
                  disabled={
                    creating ||
                    !canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities)
                  }
                  onClick={createFromPlan}
                >
                  {creating
                    ? 'Creating…'
                    : `▶ Create assessment from this plan (${planPicks.length})`}
                </button>
              </div>
            )}
            <p>
              <b>{analysis.summary.high}</b> high · <b>{analysis.summary.medium}</b> medium ·{' '}
              <b>{analysis.summary.low}</b> low priority to replay ·{' '}
              <b>{analysis.summary.attested}</b> attestation-only.
            </p>
            {analysis.breakPoint ? (
              <div className="gap-break">
                <b>
                  Predicted break point — line {analysis.breakPoint.line} (
                  {analysis.breakPoint.name}, DRS{analysis.breakPoint.drs}).
                </b>{' '}
                {analysis.breakPoint.note}
              </div>
            ) : (
              <div className="gap-break gap-break-ok">
                <b>No gap on the ladder from the declared controls.</b> Escalate the full DRS 3→5
                sequence to confirm the ceiling, watching collateral on the probe.
              </div>
            )}
            <h3 style={{ marginBottom: '.25rem' }}>DRS escalation ladder (replay in this order)</h3>
            {[...new Set(analysis.plan.map((p) => p.drs))]
              .sort((x, y) => x - y)
              .map((drs) => (
                <div key={drs}>
                  <p className="gap-tier">{analysis.plan.find((p) => p.drs === drs)!.tier}</p>
                  {analysis.plan
                    .filter((p) => p.drs === drs)
                    .map((p) => (
                      <div
                        key={p.line}
                        className={`gap-plan-item${
                          p.line === analysis.breakPoint?.line ? ' gap-breakrow' : ''
                        }`}
                      >
                        <span className={`gap-pill ${GAP_PILL[p.priority]}`}>{p.priority}</span>
                        <div>
                          <b>
                            Line {p.line} — {p.name}
                          </b>
                          {p.combination && <span className="gap-tag">combo</span>}
                          {p.line === analysis.breakPoint?.line && (
                            <span className="gap-tag gap-tag-break">break point</span>
                          )}
                          <div className="hint">
                            {p.controls.map((c, i) => (
                              <span key={c.key}>
                                {i > 0 ? ' · ' : ''}
                                <span className={c.key === p.weakest.key ? 'gap-weak' : ''}>
                                  {c.label} ({c.status})
                                </span>
                              </span>
                            ))}
                          </div>
                          <div className="hint">
                            Replay <code>{p.step}</code>
                            {p.intensity
                              ? ` — ≤ ${p.intensity.maxRps} rps · ${p.intensity.concurrency} conns · ${p.intensity.durationSec}s · ${p.intensity.profile}`
                              : ''}
                            . {p.rationale}
                            {p.attestedNote ? ` ⚠ ${p.attestedNote}` : ''}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              ))}
            <h3 style={{ margin: '.75rem 0 .25rem' }}>
              Attestation-only (out of the bounded model)
            </h3>
            {analysis.attestationOnly.map((x) => (
              <div key={x.line} className="gap-plan-item">
                <span className="gap-pill" style={{ background: 'var(--muted)' }}>
                  attest
                </span>
                <div>
                  <b>
                    Line {x.line} · DRS{x.drs} — {x.name}
                  </b>
                  <div className="hint">
                    {x.controls.map((c) => `${c.label} (${c.status})`).join(' · ')} — {x.note}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------- Audit log ----------
/** The tamper-evident audit log body (actions + hash-chained entries), reused by
 *  the standalone page and the Settings "Audit log" section. */
export function AuditLog() {
  const app = useApp();
  const { loadAudit } = app;
  const [verdict, setVerdict] = useState<AuditVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    loadAudit();
  }, [loadAudit]);
  const verify = async () => {
    setVerifying(true);
    try {
      setVerdict(await api.verifyAudit());
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setVerifying(false);
    }
  };
  const rows = app.auditRows;
  return (
    <>
      <div className="page-actions">
        <button className="btn btn-sm" onClick={app.loadAudit}>
          Refresh
        </button>
        <button className="btn btn-sm" onClick={verify} disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify integrity'}
        </button>
        <a className="btn btn-sm btn-ghost" href={auditExportUrl()}>
          Export (JSON)
        </a>
        {verdict && (
          <span
            className={`engine-badge ${verdict.ok ? 'ok' : 'no'}`}
            title={
              verdict.ok
                ? `head ${verdict.headHash.slice(0, 12)}…`
                : `broken at #${verdict.brokenAt?.index} (${verdict.brokenAt?.reason})`
            }
          >
            {verdict.ok
              ? `Chain intact · ${verdict.count} entries`
              : `Tampering detected (${verdict.brokenAt?.reason})`}
          </span>
        )}
      </div>
      <div className="card">
        {rows === null && <span className="hint">Loading…</span>}
        {rows !== null && rows.length === 0 && <span className="hint">No entries.</span>}
        {rows?.map((a) => (
          <div key={a.id} className="audit-row">
            <span className="audit-time">{new Date(a.at).toLocaleString()}</span>
            <span className="audit-actor">{a.actor}</span>
            <span className={`audit-action a-${a.action.replace('.', '-')}`}>{a.action}</span>
            <span className="audit-detail">{a.detail ?? ''}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The user's own space — profile, security and preferences. Distinct from
 * Settings, which is platform administration. Reached from the identity chip in
 * the sidebar.
 */
export function AccountPage() {
  const app = useApp();
  const id = app.identity;
  const email = id?.email ?? app.operator;
  const initials = (email || '?').split(/[@.]/)[0].slice(0, 2).toUpperCase();
  // Shared reactive theme — stays in sync with the sidebar toggle.
  const theme = useTheme();
  const chooseTheme = (t: Theme) => persistTheme(t);
  return (
    <>
      <PageHead title="My account" sub="Your profile, security and preferences." />
      <div className="account-grid">
        <section className="card account-id">
          <div className="account-avatar" aria-hidden="true">
            {initials}
          </div>
          <div className="account-id-body">
            <div className="account-email">{email || '—'}</div>
            {app.authRequired && id ? (
              <>
                <span className={`role-chip role-${id.role}`}>{roleLabel[id.role]}</span>
                <p className="hint account-role-desc">
                  {app.approvalPolicy === 'confirmation'
                    ? 'Owner administrator — manage accounts, targets, campaigns, reports and operational limits.'
                    : roleDescription[id.role]}
                </p>
              </>
            ) : (
              <p className="hint">Dev mode — authentication is disabled on this control plane.</p>
            )}
          </div>
          {app.authRequired && id && (
            <button className="btn btn-sm btn-ghost account-signout" onClick={app.logout}>
              Sign out
            </button>
          )}
        </section>

        {app.authRequired && id ? (
          <section className="card">
            <h2>Security</h2>
            <p className="hint" style={{ marginBottom: '.75rem' }}>
              Change your password — this signs out your other active sessions.
            </p>
            <ChangePasswordForm />
            <button
              className="btn"
              onClick={() =>
                void app.revokeOwnSessions().catch((err: Error) => app.push('error', err.message))
              }
            >
              Revoke other sessions
            </button>
          </section>
        ) : (
          <section className="card">
            <h2>Operator identity</h2>
            <div className="field" style={{ maxWidth: 360 }}>
              <label htmlFor="op">Operator (dev mode)</label>
              <input
                id="op"
                placeholder="first.last@wedos"
                value={app.operator}
                onChange={(e) => app.setOperator(e.target.value)}
              />
              <span className="hint">
                Used as author/approver while authentication is disabled.
              </span>
            </div>
          </section>
        )}

        <section className="card">
          <h2>Preferences</h2>
          <div className="pref-row">
            <div>
              <div className="pref-k">Appearance</div>
              <div className="hint">How ShieldTest looks on this device.</div>
            </div>
            <div className="theme-choice" role="group" aria-label="Theme">
              {THEME_OPTS.map(([v, icon, label]) => (
                <button
                  key={v}
                  type="button"
                  className={`theme-choice-btn${theme === v ? ' active' : ''}`}
                  aria-pressed={theme === v}
                  onClick={() => chooseTheme(v)}
                >
                  <span aria-hidden="true">{icon}</span> {label}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

export function SettingsPage() {
  const app = useApp();
  return (
    <>
      <PageHead
        title="Settings"
        sub="Platform administration — engines, users, limits and observability."
      />
      <div className="card">
        <div className="card-head">
          <h2>Engine &amp; security</h2>
          <AiSupportButton
            title="Engine & security"
            context="the platform engine and security posture — active agent, JWT/RBAC, protection integration, TLS verification and the allowed/lab targets."
          />
        </div>
        <div className="kv">
          <div>
            <span className="k">Active agent</span>
            <span className="v">
              <code>{app.agentName || 'builtin-http'}</code>
            </span>
          </div>
          <div>
            <span className="k">Authentication</span>
            <span className="v">
              {app.authRequired ? 'JWT / RBAC enabled' : 'Dev mode (disabled)'}
            </span>
          </div>
          <div>
            <span className="k">Protection integration</span>
            <span className="v">
              {app.protection ? (
                <span className="engine-badge ok">Measured WRS</span>
              ) : (
                <span className="engine-badge no">Estimated WRS</span>
              )}
            </span>
          </div>
          <div>
            <span className="k">TLS verification</span>
            <span className="v">
              {app.tlsInsecure ? (
                <span className="engine-badge no">Disabled (INSECURE_TLS — lab only)</span>
              ) : (
                <span className="engine-badge ok">Enabled</span>
              )}
            </span>
          </div>
          <div>
            <span className="k">Allowed targets</span>
            <span className="v">
              <code>{app.allowed.join(', ') || '—'}</code>
            </span>
          </div>
          {(app.labTargets ?? []).length > 0 && (
            <div>
              <span className="k">Lab targets (DRS)</span>
              <span className="v">
                <code>{app.labTargets.join(', ')}</code>
              </span>
            </div>
          )}
        </div>
        <p className="hint" style={{ marginTop: '.75rem' }}>
          Bounded HTTP generator only (GET/POST, rate-capped, allowlisted). No volumetric or
          exhaustion vector is implemented. The allowlist and the default agent are configured
          server-side (environment variables).
        </p>
      </div>

      <LimitsCard />

      <BenchCard />

      <UsersCard />
      <PurgeCard />

      <NotificationsCard />

      <ObservabilityCard />

      <div className="card">
        <div className="card-head">
          <h2>Load engines</h2>
          <AiSupportButton
            title="Load engines"
            context="the installed load generators (builtin-http, k6, vegeta, locust, jmeter, gatling) and their capabilities/constraints."
          />
        </div>
        <p className="hint" style={{ marginBottom: '.75rem' }}>
          Third-party generators are operated by the team and delegated to via adapters — all
          produce bounded HTTP load only. A campaign can pick any installed engine; unavailable ones
          must be installed on the server.
        </p>
        <EnginesList />
      </div>

      <h2 className="settings-section-title">Audit log</h2>
      <p className="hint" style={{ margin: '0 0 .5rem' }}>
        Tamper-evident record — every governed action (creation, approval, run, kill switch),
        hash-chained. Verify the chain or export it below.
      </p>
      <AuditLog />
    </>
  );
}
