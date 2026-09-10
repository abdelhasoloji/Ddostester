import { Fragment, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate, Link } from 'react-router-dom';
import {
  api,
  auditExportUrl,
  complianceUrl,
  compareUrl,
  reportUrl,
  runsCsvUrl,
  suiteReportUrl,
  suiteCompareUrl,
} from './api.js';
import type {
  AttestationChecklist,
  AuditVerdict,
  BenchCatalogue,
  BenchCoverage,
  BenchRun,
  CoverageMethod,
  Campaign,
  CampaignRun,
  CampaignStatus,
  HardCaps,
  ManagedUser,
  Role,
  SuiteSummary,
  SuiteSequenceState,
  WrsBreakdown,
  ControlKey,
  ControlStatus,
  ProtectionProfile,
  GapAnalysis,
  Priority,
} from './api.js';
import { RECORDABLE_METHODS, GAP_CONTROLS } from './api.js';
import { useApp, canDo } from './context.js';
import { APP_VERSION_LABEL, APP_BUILT, APP_COMMIT } from './version.js';
import {
  ApproveModal,
  CampaignCard,
  CampaignDrawer,
  ExecuteModal,
  NewCampaignForm,
  NewCampaignWizard,
  VerdictBadge,
  WrsPill,
  WrsTrend,
  wrsClass,
  AbsorptionWidget,
} from './ui.js';
import { PRESETS, PRESET_CATEGORIES, estimatedRequests, formatCount } from './presets.js';
import type { Preset } from './presets.js';
import { getTheme, setTheme as persistTheme } from './theme.js';
import type { Theme } from './theme.js';

const roleLabel: Record<Role, string> = {
  officer: 'Security Officer',
  engineer: 'Security Engineer',
  viewer: 'SOC / NOC',
  ciso: 'CISO',
};

// ---------- sidebar + layout ----------
// Campaign orchestration is the whole point of the tool, so it is the single
// primary destination (the home page). Everything else — the assessment phases,
// templates, reports, audit, guide and settings — stays one click away under a
// collapsible "More" menu, keeping the sidebar focused instead of a flat list.
// v2 — the resilience spine: land on status (Command Center), then the workflow
// arc (Prepare → Campaigns → Results) and governance (Assurance). Secondary
// destinations stay reachable under "More"; Guide/Settings live in the foot.
const SPINE_NAV = [
  { to: '/', label: 'Command Center', icon: '🛰', end: true },
  { to: '/prepare', label: 'Prepare', icon: '🔍' },
  { to: '/campaigns', label: 'Campaigns', icon: '◇' },
  { to: '/reports', label: 'Results', icon: '🛡' },
  { to: '/audit', label: 'Assurance', icon: '⚖' },
];
const MORE_NAV = [
  { to: '/overview', label: 'Overview', icon: '▚' },
  { to: '/plan', label: 'Plan', icon: '◈' },
  { to: '/templates', label: 'Templates', icon: '▦' },
  { to: '/guide', label: 'Guide', icon: '❔' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

/** Collapsible "More" group: keeps every non-campaign destination reachable
 *  without cluttering the primary navigation. */
function MoreNav() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`nav-more${open ? ' open' : ''}`}>
      <button
        type="button"
        className="nav-more-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="nav-icon" aria-hidden="true">
          ⋯
        </span>
        More
        <span className="nav-more-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="nav-more-list">
          {MORE_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon" aria-hidden="true">
                {n.icon}
              </span>
              {n.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

const THEME_OPTS: [Theme, string, string][] = [
  ['light', '☀', 'Light'],
  ['system', '🖥', 'System'],
  ['dark', '☾', 'Dark'],
];

function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const choose = (t: Theme) => {
    setThemeState(t);
    persistTheme(t);
  };
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {THEME_OPTS.map(([v, icon, label]) => (
        <button
          key={v}
          type="button"
          className={`theme-btn${theme === v ? ' active' : ''}`}
          title={`Theme: ${label}`}
          aria-pressed={theme === v}
          onClick={() => choose(v)}
        >
          <span aria-hidden="true">{icon}</span>
        </button>
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

const gradeFromScore = (n: number): WrsBreakdown['level'] =>
  n >= 90 ? 'A+' : n >= 80 ? 'A' : n >= 70 ? 'B' : n >= 60 ? 'C' : n >= 50 ? 'D' : 'F';

/**
 * v2 Command Center — the new front door. Composes fleet resilience, live alerts,
 * runs in flight, generator health and the last result (with its absorption) from
 * data already in context, so one scan tells you if anything needs you.
 */
export function CommandCenterPage() {
  const app = useApp();
  const c = app.campaigns;
  const scored = c.filter((x) => x.wrs);
  const fleet = scored.length
    ? Math.round(scored.reduce((s, x) => s + (x.wrs?.wrs ?? 0), 0) / scored.length)
    : null;
  const running = c.filter((x) => x.status === 'RUNNING');
  const alerts = app.alerts ?? [];
  const degraded = alerts.some((a) => a.kind === 'degraded');
  const health = degraded ? 'degraded' : running.length ? 'busy' : 'nominal';
  const last = scored.find((x) => x.runId) ?? scored[0];
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
            Fleet resilience · {scored.length} target{scored.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{running.length}</div>
          <div className="kpi-k">Runs in flight</div>
        </div>
        <div className="kpi">
          <div className="kpi-v" style={{ textTransform: 'capitalize' }}>
            {health}
          </div>
          <div className="kpi-k">Generator health</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{alerts.length}</div>
          <div className="kpi-k">Active alerts</div>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="section-title">Active alerts · from recent runs</div>
          <ul className="alerts-list">
            {alerts.slice(0, 6).map((a) => (
              <li key={a.key} className={`alert-row alert-${a.severity}`}>
                <span className="alert-dot" aria-hidden="true" />
                <span className="alert-title">{a.title}</span>
                <span className="alert-detail">{a.detail}</span>
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
          <div className="section-title">
            Last result · {last.name} <span className="muted">→ {last.target}</span>
          </div>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.4rem' }}
          >
            {last.wrs && <WrsPill wrs={last.wrs} />}
            {lastRun?.confidence?.degraded && (
              <span className="badge warn" title={lastRun.confidence.reasons.join(' ')}>
                ⚠ measurement degraded
              </span>
            )}
            <Link to="/reports" className="hint" style={{ marginLeft: 'auto' }}>
              View reports →
            </Link>
          </div>
          {lastRun && <AbsorptionWidget run={lastRun} />}
        </div>
      )}

      {trend && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="section-title">WRS trend · {trend.target}</div>
          <WrsTrend points={trend.points} regression={trend.regression} />
        </div>
      )}

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
 * In-app alerts banner — surfaces the signals derived from recent run history
 * (tarpit / low-WRS / measurement-degraded / auto-killed) so the app is a single
 * pane of glass without opening Grafana. Alerts are dismissible for the session.
 */
function AlertsBanner() {
  const { alerts } = useApp();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const list = alerts ?? [];
  const active = list.filter((a) => !dismissed.has(a.key));
  if (active.length === 0) return null;
  const worst = active.some((a) => a.severity === 'critical')
    ? 'critical'
    : active.some((a) => a.severity === 'warning')
      ? 'warning'
      : 'info';
  return (
    <div className={`alerts-banner alerts-${worst}`} role="alert">
      <div className="alerts-banner-head">
        <span>
          🔔 {active.length} alert{active.length > 1 ? 's' : ''} from recent runs
        </span>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setDismissed(new Set(list.map((a) => a.key)))}
        >
          Dismiss all
        </button>
      </div>
      <ul className="alerts-list">
        {active.slice(0, 5).map((a) => (
          <li key={a.key} className={`alert-row alert-${a.severity}`}>
            <span className="alert-dot" aria-hidden="true" />
            <span className="alert-title">{a.title}</span>
            <span className="alert-detail">{a.detail}</span>
            <button
              className="alert-x"
              aria-label="Dismiss alert"
              onClick={() => setDismissed((d) => new Set([...d, a.key]))}
            >
              ×
            </button>
          </li>
        ))}
        {active.length > 5 && <li className="alert-more">+{active.length - 5} more…</li>}
      </ul>
    </div>
  );
}

export function Layout() {
  const app = useApp();
  const { toasts } = app;
  const sv = app.serverVersion;
  const mismatch = isBuildMismatch(sv);
  return (
    <>
      <div className="accent-line" />
      <div className="shell">
        <aside className="sidebar">
          <div className="brand-lockup sidebar-brand">
            <img className="brand-logo logo-light" src="/wedos-logo.png" alt="WEDOS" />
            <img className="brand-logo logo-dark" src="/wedos-logo-white.png" alt="WEDOS" />
            <span className="brand-tag">ShieldTest</span>
          </div>
          <nav className="nav">
            {SPINE_NAV.map((n) => (
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
            <MoreNav />
          </nav>
          <div className="sidebar-foot">
            <ThemeToggle />
            {app.authRequired && app.identity ? (
              <>
                <span className="hint">
                  {app.identity.email}
                  <br />
                  <b>{roleLabel[app.identity.role]}</b>
                </span>
                <button className="btn btn-sm btn-ghost" onClick={app.logout}>
                  Sign out
                </button>
              </>
            ) : (
              <span className="hint">
                Dev mode · operator <b>{app.operator || '—'}</b>
              </span>
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
          <AlertsBanner />
          <Outlet />
        </main>
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

// ---------- Overview ----------
export function OverviewPage() {
  const app = useApp();
  const c = app.campaigns;
  const scored = c.filter((x) => x.wrs);
  const avgWrs = scored.length
    ? Math.round(scored.reduce((s, x) => s + (x.wrs?.wrs ?? 0), 0) / scored.length)
    : null;
  const running = c.filter((x) => x.status === 'RUNNING').length;
  const pending = c.filter((x) => x.status === 'PENDING_APPROVAL').length;
  const completed = c.filter((x) =>
    ['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL'].includes(x.status),
  ).length;

  return (
    <>
      <PageHead
        title="Overview"
        sub={
          <>
            Allowed targets: <code>{app.allowed.join(', ') || '—'}</code>
            {app.agentName && (
              <>
                {' '}
                · default engine <code>{app.agentName}</code>
              </>
            )}{' '}
            · bounded HTTP generator (no volumetric vector).
          </>
        }
      />

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-v">{c.length}</div>
          <div className="kpi-k">Campaigns</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{running}</div>
          <div className="kpi-k">Running</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{pending}</div>
          <div className="kpi-k">Pending</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{completed}</div>
          <div className="kpi-k">Completed</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{avgWrs ?? '—'}</div>
          <div className="kpi-k">Avg. WRS</div>
        </div>
      </div>

      <h2 className="section-title">WRS history by target</h2>
      {app.wrsSeries.length === 0 ? (
        <div className="empty">No scored runs yet.</div>
      ) : (
        <div className="card" style={{ display: 'grid', gap: '.75rem' }}>
          {app.wrsSeries.map((s) => {
            const last = s.points[s.points.length - 1];
            return (
              <div key={s.target} className="wrs-hist">
                <div className="wrs-hist-main">
                  <code>{s.target}</code>
                  <span className={`wrs ${wrsClass(last.level as WrsBreakdown['level'])}`}>
                    <span className="wrs-score">{last.wrs}</span> {last.level}
                  </span>
                  <span className="hint">{s.points.length} run(s)</span>
                  {s.regression && (
                    <span className="badge badge-REJECTED" title="Drop of more than 10 points">
                      ▼ Regression −{s.drop}
                    </span>
                  )}
                </div>
                <WrsTrend points={s.points} regression={s.regression} />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------- Campaigns ----------
type StatusFilterId = 'all' | 'pending' | 'approved' | 'running' | 'done' | 'rejected';
const STATUS_FILTERS: { id: StatusFilterId; label: string; match: (c: Campaign) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'pending', label: 'Pending', match: (c) => c.status === 'PENDING_APPROVAL' },
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
  const canRun = canDo(app.role, 'approve', app.authRequired);
  const [busy, setBusy] = useState<string | null>(null);
  const [sequences, setSequences] = useState<Record<string, SuiteSequenceState>>({});
  const groups = useMemo(() => groupSuites(app.campaigns), [app.campaigns]);
  const active = groups.filter((g) => g.remaining > 0);

  // Keep the list fresh for the whole sequence — between steps there may be no
  // RUNNING campaign, so the global "anyRunning" poll can lapse; poll here too,
  // and refresh the live sequence-control state (paused / current step).
  const inFlight = active.length > 0;
  const pullSequences = () =>
    api
      .suiteSequences()
      .then((r) => setSequences(r.sequences))
      .catch(() => undefined);
  useEffect(() => {
    if (!inFlight) return;
    pullSequences();
    const t = setInterval(() => {
      app.refresh();
      pullSequences();
    }, 3000);
    return () => clearInterval(t);
  }, [inFlight, app]);

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
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={isBusy}
                      onClick={() =>
                        act(
                          g.suiteId,
                          () => api.runSuite(g.suiteId),
                          `Scenario approved — remaining steps will run in order.`,
                        )
                      }
                      title="One approval for the whole scenario: approves + runs every remaining step in order"
                    >
                      {isBusy ? 'Starting…' : `▶ Approve & run whole scenario (${g.remaining})`}
                    </button>
                  ) : (
                    <>
                      {paused ? (
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={isBusy}
                          onClick={() =>
                            act(g.suiteId, () => api.resumeSuite(g.suiteId), 'Scenario resumed.')
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
                              'Scenario will pause after the current step.',
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
                            'Scenario cancelled — step in flight stopped.',
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
            <div className="live-bar" aria-label="Scenario progress">
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
            <div className="suite-steps">
              {g.members.map((m) => (
                <span
                  key={m.id}
                  className={`chip-xs ${SUITE_STEP_CLASS[m.status] ?? ''}`}
                  title={m.status}
                >
                  {(m.suiteOrder ?? 0) + 1}. {stepLabel(m, g.suiteName)}
                  {m.wrs ? ` · ${m.wrs.wrs} ${m.wrs.level}` : ''}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CampaignsPage() {
  const app = useApp();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilterId>('all');
  const [sort, setSort] = useState<SortId>('recent');

  const filtered = useMemo(() => {
    const matchStatus = STATUS_FILTERS.find((f) => f.id === status)!.match;
    let list = app.campaigns.filter(matchStatus);
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter(
        (c) => c.name.toLowerCase().includes(term) || c.target.toLowerCase().includes(term),
      );
    }
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'wrs')
      list = [...list].sort((a, b) => (b.wrs?.wrs ?? -1) - (a.wrs?.wrs ?? -1));
    return list;
  }, [app.campaigns, status, q, sort]);

  const hasCampaigns = app.campaigns.length > 0;
  const canCreate = canDo(app.role, 'create', app.authRequired);
  const [showForm, setShowForm] = useState(false);
  // Open the form automatically when a preset is queued from the Guide.
  useEffect(() => {
    if (app.draftPreset) setShowForm(true);
  }, [app.draftPreset]);

  return (
    <>
      <PageHead title="Campaigns" sub={app.anyRunning ? 'Auto-refreshing…' : undefined} />

      <SuiteRunBanner />

      {canCreate && !showForm && (
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            ＋ New campaign
          </button>
        </div>
      )}
      {showForm &&
        (app.draftPreset ? (
          // A preset queued from the Guide jumps straight into the classic form
          // (which consumes draftPreset); the "＋ New campaign" button uses the
          // guided wizard.
          <NewCampaignForm onDone={() => setShowForm(false)} />
        ) : (
          <NewCampaignWizard onDone={() => setShowForm(false)} />
        ))}

      <h2 className="section-title">
        Campaign list <span className="hint">({filtered.length})</span>
      </h2>

      {hasCampaigns && (
        <div className="filter-bar">
          <div className="filter-chips">
            {STATUS_FILTERS.map((f) => {
              const n = app.campaigns.filter(f.match).length;
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
              type="search"
              placeholder="Search name or target…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select value={sort} onChange={(e) => setSort(e.target.value as SortId)}>
              <option value="recent">Most recent</option>
              <option value="name">Name (A–Z)</option>
              <option value="wrs">WRS (high→low)</option>
            </select>
          </div>
        </div>
      )}

      <div className="campaigns">
        {!hasCampaigns && <div className="empty">No campaigns yet.</div>}
        {hasCampaigns && filtered.length === 0 && (
          <div className="empty">No campaigns match your filters.</div>
        )}
        {filtered.map((c) => (
          <CampaignCard key={c.id} c={c} />
        ))}
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

function SuitesSection() {
  const [suites, setSuites] = useState<SuiteSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const app = useApp();
  const canRun = canDo(app.role, 'approve', app.authRequired);
  useEffect(() => {
    api
      .suites()
      .then(setSuites)
      .catch(() => undefined);
    // Re-read when the campaign list changes (new suites / new scores).
  }, [app.campaigns]);

  // While any suite still has steps to run, poll so the sequence is watchable.
  const inFlight = suites.some((s) => s.completed < s.total);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => app.refresh(), 4000);
    return () => clearInterval(t);
  }, [inFlight, app]);

  if (suites.length === 0) return null;

  const runSequence = async (s: SuiteSummary) => {
    setBusy(s.suiteId);
    try {
      const r = await api.runSuite(s.suiteId);
      app.push('success', `Sequence started — ${r.steps} steps will run in order.`);
      await app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h2 className="section-title">Assessment suites</h2>
      <div className="card" style={{ display: 'grid', gap: '.75rem', marginBottom: '1rem' }}>
        {suites.map((s, i) => {
          const remaining = s.total - s.completed;
          const sequencing = s.running > 0;
          // Suites are newest-first; the previous replay of the same playbook on
          // the same target (if any) is the next match further down the list.
          const prev = suites
            .slice(i + 1)
            .find((o) => o.suiteName === s.suiteName && o.target === s.target);
          return (
            <div key={s.suiteId} className="wrs-hist">
              <div className="wrs-hist-main">
                <b>{s.suiteName}</b>
                <code>{s.target}</code>
                {s.wrs ? (
                  <span
                    className={`wrs ${wrsClass(s.wrs.level)}`}
                    title="Aggregate: worst-step WRS"
                  >
                    <span className="wrs-score">{s.wrs.min}</span> {s.wrs.level}
                    <span className="hint" style={{ marginLeft: '.4rem' }}>
                      avg {s.wrs.avg}
                    </span>
                  </span>
                ) : (
                  <span className="hint">not scored yet</span>
                )}
                {s.verdict && <VerdictBadge verdict={s.verdict} />}
                <span className="hint">
                  {s.completed}/{s.total} done
                  {s.pending ? ` · ${s.pending} pending` : ''}
                  {s.running ? ` · ${s.running} running` : ''}
                </span>
                {canRun && remaining > 0 && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy === s.suiteId || sequencing}
                    onClick={() => runSequence(s)}
                    title="Approve + run every remaining step in order, advancing through auto-kills"
                  >
                    {busy === s.suiteId
                      ? 'Starting…'
                      : sequencing
                        ? 'Running…'
                        : `▶ Run sequence (${remaining})`}
                  </button>
                )}
                <a
                  className="btn btn-sm btn-ghost"
                  href={suiteReportUrl(s.suiteId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Suite report ↗
                </a>
                {prev && (
                  <a
                    className="btn btn-sm btn-ghost"
                    href={suiteCompareUrl(prev.suiteId, s.suiteId)}
                    target="_blank"
                    rel="noreferrer"
                    title="Per-line WRS/verdict vs the previous replay of this playbook (tune & replay)"
                  >
                    Compare vs previous ↗
                  </a>
                )}
              </div>
              <div className="suite-steps">
                {s.members.map((m) => (
                  <span
                    key={m.id}
                    className={`chip-xs ${SUITE_STEP_CLASS[m.status] ?? ''}`}
                    title={m.status}
                  >
                    {m.order + 1}.{' '}
                    {m.name.startsWith(`${s.suiteName} — `)
                      ? m.name.slice(s.suiteName.length + 3)
                      : m.name}
                    {m.wrs != null ? ` · ${m.wrs} ${m.level}` : ''}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
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
export function GapPlannerSection() {
  const app = useApp();
  const [target, setTarget] = useState('bank.cz');
  const [profile, setProfile] = useState<ProtectionProfile>({});
  const [analysis, setAnalysis] = useState<GapAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Recon → Plan handoff: if the Preparation page sent observed controls, seed
  // the target + profile from them (once), then clear the handoff.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('shieldtest.reconHandoff');
      if (!raw) return;
      sessionStorage.removeItem('shieldtest.reconHandoff');
      const h = JSON.parse(raw) as { target?: string; seededProfile?: ProtectionProfile };
      if (h.target) setTarget(h.target);
      if (h.seededProfile) setProfile(h.seededProfile);
      setSeeded(true);
    } catch {
      /* no usable handoff */
    }
  }, []);

  const setControl = (key: ControlKey, status: ControlStatus) =>
    setProfile((p) => ({ ...p, [key]: status }));

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

  return (
    <>
      <h2 className="section-title">Protection-gap planner</h2>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <p className="hint" style={{ marginTop: 0 }}>
          Declare the target's WEDOS controls; get a prioritised plan of which bounded{' '}
          <code>pretest-cra-l7</code> lines to replay first, then measure each with the
          suite-compare. Analytical only — it orders existing bounded tests against the authorized
          target; it never synthesises attacks or relaxes a cap.
        </p>
        {seeded && (
          <p className="gap-break gap-break-ok" style={{ marginTop: 0 }}>
            Seeded from recon — target and observed controls pre-filled. Adjust and analyze.
          </p>
        )}
        <label className="field" style={{ maxWidth: '22rem' }}>
          <span>Target</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="bank.cz" />
        </label>
        <div className="gap-controls">
          {GAP_CONTROLS.map((c) => (
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
            </Fragment>
          ))}
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={analyze} disabled={busy}>
            {busy ? 'Analyzing…' : 'Analyze gaps'}
          </button>
        </div>

        {analysis && (
          <div style={{ marginTop: '1rem' }}>
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

export function ReportsPage() {
  const app = useApp();
  const withRun = app.campaigns.filter((c) => c.runId);
  return (
    <>
      <PageHead
        title="Reports"
        sub="Assessment suites, campaign reports (HTML/PDF) and aggregated DORA / NIS2 compliance."
      />
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
      </div>

      <h2 className="section-title">Campaign reports</h2>
      {withRun.length === 0 ? (
        <div className="empty">No campaign has run yet — no report available.</div>
      ) : (
        <div className="card" style={{ display: 'grid', gap: '.5rem' }}>
          {withRun.map((c) => (
            <div key={c.id} className="report-row">
              <span className="report-name">{c.name}</span>
              {c.wrs && <WrsPill wrs={c.wrs} />}
              <code className="report-target">{c.target}</code>
              <a
                className="btn btn-sm btn-ghost"
                href={reportUrl(c.runId!)}
                target="_blank"
                rel="noreferrer"
              >
                Report ↗
              </a>
            </div>
          ))}
        </div>
      )}
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
function CompareSection({ campaigns }: { campaigns: Campaign[] }) {
  const [a, setA] = useState(campaigns[0]?.id ?? '');
  const [b, setB] = useState(campaigns[1]?.id ?? '');
  const ca = campaigns.find((c) => c.id === a);
  const cb = campaigns.find((c) => c.id === b);
  const opt = (c: Campaign) => `${c.name}${c.wrs ? ` — WRS ${c.wrs.wrs}` : ''}`;
  const canCompare = ca?.runId && cb?.runId && a !== b;
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2>Before / after comparison</h2>
      <p className="hint">
        Compare two runs (typically the same target before and after a protection change) — WRS,
        availability, latency, mitigation and TTD/TTM, side by side.
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
        {canCompare ? (
          <a
            className="btn btn-primary btn-sm"
            href={compareUrl(ca!.runId!, cb!.runId!)}
            target="_blank"
            rel="noreferrer"
          >
            Open comparison ↗
          </a>
        ) : (
          <button className="btn btn-primary btn-sm" disabled>
            Open comparison ↗
          </button>
        )}
      </div>
      {a !== '' && a === b && <p className="hint">Pick two different runs to compare.</p>}
    </div>
  );
}

// ---------- Audit log ----------
export function AuditPage() {
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
      <PageHead
        title="Audit log"
        sub="Immutable trace of actions (creation, approval, run, kill switch)."
      />
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

// ---------- Settings ----------
function UsersCard() {
  const app = useApp();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [form, setForm] = useState({ email: '', role: 'viewer' as Role, password: '' });
  const [busy, setBusy] = useState(false);
  const show = app.authRequired && canDo(app.role, 'manage', app.authRequired);

  const load = () => {
    api
      .listUsers()
      .then(setUsers)
      .catch((err) => app.push('error', (err as Error).message));
  };
  useEffect(() => {
    if (show) load();
  }, [show]);

  if (!show) return null;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createUser(form);
      app.push('success', `User ${form.email} saved.`);
      setForm({ email: '', role: 'viewer', password: '' });
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (email: string) => {
    try {
      await api.deleteUser(email);
      app.push('success', `User ${email} removed.`);
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };
  const changeRole = async (email: string, role: Role) => {
    try {
      await api.updateUserRole(email, role);
      app.push('success', `${email} is now ${roleLabel[role]}.`);
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
      load(); // revert the dropdown to the stored value
    }
  };

  const me = app.identity?.email;
  return (
    <div className="card">
      <h2>Users &amp; access</h2>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        Manage runtime users. Users defined in <code>AUTH_USERS</code> (env) are the immutable root
        and are shown as <b>env</b>; they can&apos;t be edited here. Every change is audited.
      </p>
      {users === null ? (
        <span className="hint">Loading…</span>
      ) : (
        <div className="engines" style={{ marginBottom: '1rem' }}>
          {users.map((u) => (
            <div key={u.email} className="engine-row">
              <span className="engine-name">{u.email}</span>
              {u.source === 'store' && u.email !== me ? (
                <select
                  className="role-select"
                  value={u.role}
                  onChange={(e) => changeRole(u.email, e.target.value as Role)}
                  title="Change role"
                >
                  <option value="viewer">SOC / NOC (read + kill)</option>
                  <option value="engineer">Security Engineer</option>
                  <option value="officer">Security Officer</option>
                  <option value="ciso">CISO (governs limits)</option>
                </select>
              ) : (
                <span className="engine-badge ok">{roleLabel[u.role]}</span>
              )}
              <span className={`engine-badge ${u.source === 'env' ? 'no' : 'ok'}`}>{u.source}</span>
              {u.source === 'store' && u.email !== me && (
                <button className="btn btn-sm btn-ghost" onClick={() => remove(u.email)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <form className="grid" onSubmit={add}>
        <div className="field">
          <label>Email</label>
          <input
            type="email"
            placeholder="first.last@wedos"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
        </div>
        <div className="field">
          <label>Role</label>
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
          >
            <option value="viewer">SOC / NOC (read + kill)</option>
            <option value="engineer">Security Engineer</option>
            <option value="officer">Security Officer</option>
            <option value="ciso">CISO (governs limits)</option>
          </select>
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            placeholder="min. 8 characters"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </div>
        <div className="field" style={{ alignSelf: 'end' }}>
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Add / update user'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * CISO-only editor for the operational limits (the effective caps). The absolute
 * HARD_CAPS ceiling is immutable and shown read-only — the CISO can tighten below
 * it or raise back up to it, never above. Every save is audited server-side.
 */
function LimitsCard() {
  const app = useApp();
  const ceiling = app.hardCapsCeiling;
  const canEdit = canDo(app.role, 'limits', app.authRequired);
  const [form, setForm] = useState<HardCaps>(app.hardCaps);
  const [busy, setBusy] = useState(false);
  // Keep the form in sync with the server's effective caps once /health loads.
  useEffect(() => setForm(app.hardCaps), [app.hardCaps]);

  if (!canEdit) return null;

  const fields: { key: keyof HardCaps; label: string; unit: string }[] = [
    { key: 'maxRps', label: 'Max requests/sec', unit: 'rps' },
    { key: 'maxConcurrency', label: 'Max concurrency', unit: 'workers' },
    { key: 'maxDurationSec', label: 'Max duration', unit: 'seconds' },
  ];
  const inRange = fields.every((f) => {
    const v = form[f.key];
    return Number.isInteger(v) && v >= 1 && v <= ceiling[f.key];
  });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inRange) return;
    setBusy(true);
    try {
      const r = await api.setLimits(form);
      app.applyEffectiveCaps(r.effective);
      app.push('success', 'Operational limits updated (audited).');
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Operational limits (CISO)</h2>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        Set the caps ShieldTest enforces on every campaign and playbook. They can be tightened
        freely or raised up to — but <b>never above</b> — the immutable safety ceiling below. The
        ceiling is fixed in code; only this profile can change the operational limits, and every
        change is written to the tamper-evident audit trail.
      </p>
      <form className="grid" onSubmit={save}>
        {fields.map((f) => (
          <div className="field" key={f.key}>
            <label>
              {f.label} <span className="hint">({f.unit})</span>
            </label>
            <input
              type="number"
              min={1}
              max={ceiling[f.key]}
              value={form[f.key]}
              onChange={(e) => setForm({ ...form, [f.key]: Math.floor(Number(e.target.value)) })}
              className={form[f.key] > ceiling[f.key] ? 'invalid' : ''}
            />
            <span className="hint">ceiling {ceiling[f.key]}</span>
          </div>
        ))}
        <div className="field" style={{ alignSelf: 'end' }}>
          <button className="btn btn-primary" disabled={busy || !inRange} type="submit">
            {busy ? 'Saving…' : 'Save limits'}
          </button>
        </div>
      </form>
    </div>
  );
}

function benchStatusPill(status: BenchRun['status']) {
  const color =
    status === 'COMPLETED'
      ? 'var(--success)'
      : status === 'FAILED'
        ? 'var(--danger)'
        : status === 'CLAIMED'
          ? 'var(--brand)'
          : 'var(--warning)';
  return (
    <span className="badge" style={{ background: 'var(--surface-2)', color, borderColor: color }}>
      {status}
    </span>
  );
}

function outcomePill(outcome?: string) {
  if (!outcome) return <span className="hint">—</span>;
  const color =
    outcome === 'MITIGATED'
      ? 'var(--success)'
      : outcome === 'NOT_MITIGATED'
        ? 'var(--danger)'
        : outcome === 'MITIGATED_WITH_COLLATERAL'
          ? 'var(--warning)'
          : 'var(--muted)';
  return (
    <span className="badge" style={{ background: 'var(--surface-2)', color, borderColor: color }}>
      {outcome}
    </span>
  );
}

const METHOD_COLOR: Record<CoverageMethod, string> = {
  MEASURED_LAB: 'var(--success)',
  INGESTED_EXTERNAL: 'var(--brand)',
  ATTESTED: 'var(--warning)',
  MODELLED: 'var(--muted)',
  REPLAY: 'var(--brand)',
};
function methodPill(m?: CoverageMethod) {
  if (!m) return <span className="hint">not covered</span>;
  const c = METHOD_COLOR[m];
  return (
    <span className="badge" style={{ background: 'var(--surface-2)', color: c, borderColor: c }}>
      {m.replace('_', ' ')}
    </span>
  );
}

function BenchCard() {
  const app = useApp();
  const canBench = canDo(app.role, 'bench', app.authRequired);
  const [cat, setCat] = useState<BenchCatalogue | null>(null);
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [coverage, setCoverage] = useState<BenchCoverage[]>([]);
  const [scenario, setScenario] = useState('');
  const [busy, setBusy] = useState(false);
  const [recVector, setRecVector] = useState('');
  const [recMethod, setRecMethod] = useState<CoverageMethod>('ATTESTED');
  const [recOutcome, setRecOutcome] = useState('');
  const [recSummary, setRecSummary] = useState('');
  const [recSource, setRecSource] = useState('');
  const [recOpen, setRecOpen] = useState(false);
  const [checklists, setChecklists] = useState<AttestationChecklist[]>([]);
  const [attId, setAttId] = useState('');
  const [attChecked, setAttChecked] = useState<Set<string>>(new Set());
  const [attNote, setAttNote] = useState('');
  const [attOpen, setAttOpen] = useState(false);
  const [impOpen, setImpOpen] = useState(false);
  const [impFormat, setImpFormat] = useState<'json' | 'csv'>('csv');
  const [impData, setImpData] = useState('');
  const [impSource, setImpSource] = useState('');
  const [impErrors, setImpErrors] = useState<{ row: number; error: string }[]>([]);

  const refreshRuns = async () => {
    try {
      setRuns((await api.benchRuns()).runs);
    } catch {
      /* transient — leave the last view in place */
    }
  };
  const refreshCoverage = async () => {
    try {
      setCoverage((await api.benchCoverage()).coverage);
    } catch {
      /* transient */
    }
  };

  useEffect(() => {
    if (!canBench) return;
    let alive = true;
    (async () => {
      try {
        const c = await api.benchScenarios();
        if (!alive) return;
        setCat(c);
        setScenario(c.scenarios.find((s) => s.reproducible)?.id ?? '');
        setRecVector(c.scenarios.find((s) => !s.reproducible)?.id ?? c.scenarios[0]?.id ?? '');
      } catch {
        /* no access / not configured */
      }
      try {
        const cl = (await api.benchAttestations()).checklists;
        if (alive) {
          setChecklists(cl);
          setAttId(cl[0]?.id ?? '');
        }
      } catch {
        /* no access */
      }
      await refreshRuns();
      await refreshCoverage();
    })();
    return () => {
      alive = false;
    };
  }, [canBench]);

  // Poll while a run is still in flight, so the runner's verdict lands in view.
  const pending = runs.some((r) => r.status === 'REQUESTED' || r.status === 'CLAIMED');
  useEffect(() => {
    if (!canBench || !pending) return;
    const t = setInterval(refreshRuns, 4000);
    return () => clearInterval(t);
  }, [canBench, pending]);

  if (!canBench) return null;

  const dispatch = async () => {
    if (!scenario) return;
    setBusy(true);
    try {
      await api.createBenchRun(scenario);
      app.push('success', `Bench run requested (${scenario}) — awaiting the isolated runner.`);
      await refreshRuns();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recordCoverage = async () => {
    if (!recVector || !recSummary.trim()) return;
    setBusy(true);
    try {
      await api.recordBenchCoverage({
        vector: recVector,
        method: recMethod,
        outcome: recOutcome.trim() || undefined,
        summary: recSummary.trim(),
        source: recSource.trim() || undefined,
      });
      app.push('success', `Coverage recorded for ${recVector} (${recMethod}).`);
      setRecSummary('');
      setRecOutcome('');
      setRecOpen(false);
      await refreshCoverage();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeChecklist = checklists.find((c) => c.id === attId) ?? null;
  const toggleAtt = (itemId: string) =>
    setAttChecked((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const submitAttestation = async () => {
    if (!activeChecklist) return;
    setBusy(true);
    try {
      const rec = await api.submitAttestation({
        checklistId: activeChecklist.id,
        checkedItems: [...attChecked],
        note: attNote.trim() || undefined,
      });
      app.push('success', `Attestation recorded for ${rec.vector} → ${rec.outcome ?? 'recorded'}.`);
      setAttChecked(new Set());
      setAttNote('');
      setAttOpen(false);
      await refreshCoverage();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importCoverage = async () => {
    if (!impData.trim()) return;
    setBusy(true);
    setImpErrors([]);
    try {
      const res = await api.importBenchCoverage(
        impFormat,
        impData.trim(),
        impSource.trim() || undefined,
      );
      setImpErrors(res.errors);
      if (res.imported > 0) {
        app.push(
          'success',
          `Imported ${res.imported} external verdict(s)${res.errors.length ? `, ${res.errors.length} row(s) skipped` : ''}.`,
        );
        setImpData('');
        if (res.errors.length === 0) setImpOpen(false);
        await refreshCoverage();
      } else {
        app.push('error', `No rows imported (${res.errors.length} invalid).`);
      }
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dispatchEnabled = cat?.dispatchEnabled ?? false;
  const scenarios = cat?.scenarios ?? [];
  const runnable = scenarios.filter((s) => s.reproducible);
  const selected = scenarios.find((s) => s.id === scenario);
  // Coverage is newest-first from the API → the first hit per vector is latest.
  const latestByVector = new Map<string, BenchCoverage>();
  for (const c of coverage) if (!latestByVector.has(c.vector)) latestByVector.set(c.vector, c);

  return (
    <div className="card">
      <h2>Network bench — class C (CISO)</h2>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        The <b>zeroBS DRS Volumetric</b> matrix (report P25-20300). Launch a bounded synthetic
        realization of a UDP amplification/rate vector on the isolated lab and read its verdict
        here. The control plane <b>records and governs</b> the run — it never emits the traffic. An
        isolated external runner claims the request, executes it off the control plane, and posts
        back a read-only class-C verdict. Every request and verdict is audited.
      </p>

      {!dispatchEnabled && (
        <div className="attest" style={{ marginBottom: '.75rem' }}>
          <span>
            Dispatch is <b>disabled</b>. Configure an isolated <code>LAB_TARGETS</code> host and a{' '}
            <code>BENCH_RUNNER_TOKEN</code> on the server to enable governed runs. The catalogue and
            past verdicts below remain visible.
          </span>
        </div>
      )}

      <div className="btn-row" style={{ marginBottom: '1rem' }}>
        <div className="field" style={{ flex: 1, minWidth: 260 }}>
          <label htmlFor="bench-scenario">Reproducible vector</label>
          <select
            id="bench-scenario"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          >
            {runnable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} — DRS {s.drs}
              </option>
            ))}
          </select>
          <span className="hint">{selected?.note ?? ''}</span>
        </div>
        <button
          className="btn btn-primary"
          onClick={dispatch}
          disabled={!dispatchEnabled || busy || !scenario}
        >
          {busy ? 'Requesting…' : '▶ Request run'}
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="hint">No bench runs yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="bench-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Status</th>
                <th>Outcome</th>
                <th style={{ textAlign: 'right' }}>Amplification</th>
                <th style={{ textAlign: 'right' }}>Collateral</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.scenario}</code>
                  </td>
                  <td>{benchStatusPill(r.status)}</td>
                  <td>
                    {r.status === 'FAILED' ? (
                      <span className="hint">{r.error}</span>
                    ) : (
                      outcomePill(r.verdict?.outcome)
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
                    {r.verdict?.connections
                      ? `${r.verdict.connections.saturationPct ?? 0}% sat`
                      : r.verdict?.amplificationFactor != null
                        ? `${r.verdict.amplificationFactor}×`
                        : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
                    {r.verdict?.mitigation?.collateralPct != null
                      ? `${r.verdict.mitigation.collateralPct}%`
                      : '—'}
                  </td>
                  <td className="hint">{new Date(r.requestedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {scenarios.length > 0 && (
        <>
          <h3 style={{ fontSize: '.92rem', margin: '1.25rem 0 .5rem' }}>
            zeroBS Volumetric coverage
          </h3>
          <div
            className="hint"
            style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '0 0 .6rem' }}
          >
            <span>
              <b style={{ color: 'var(--text)' }}>{scenarios.length}</b> vectors
            </span>
            <span>
              <b style={{ color: 'var(--success)' }}>
                {
                  scenarios.filter((s) => latestByVector.get(s.id)?.method === 'MEASURED_LAB')
                    .length
                }
              </b>{' '}
              measured (lab)
            </span>
            <span>
              <b style={{ color: 'var(--text)' }}>
                {scenarios.filter((s) => latestByVector.has(s.id)).length}
              </b>{' '}
              covered (any method)
            </span>
            <span>
              <b style={{ color: 'var(--text)' }}>
                {scenarios.filter((s) => !s.reproducible).length}
              </b>{' '}
              never emitted
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="bench-table">
              <thead>
                <tr>
                  <th>Vector</th>
                  <th>Proto</th>
                  <th>DRS</th>
                  <th>Bench</th>
                  <th>Coverage</th>
                  <th style={{ whiteSpace: 'normal' }}>Latest evidence</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s) => {
                  const cov = latestByVector.get(s.id);
                  return (
                    <tr key={s.id}>
                      <td>
                        <code>{s.id}</code>
                      </td>
                      <td>{s.proto}</td>
                      <td className="num">{s.drs}</td>
                      <td>
                        {s.reproducible ? (
                          <span
                            className="badge"
                            style={{
                              background: 'var(--surface-2)',
                              color: 'var(--success)',
                              borderColor: 'var(--success)',
                            }}
                          >
                            reproducible
                          </span>
                        ) : (
                          <span
                            className="badge"
                            style={{
                              background: 'var(--surface-2)',
                              color: 'var(--muted)',
                              borderColor: 'var(--border)',
                            }}
                          >
                            out of model
                          </span>
                        )}
                      </td>
                      <td>{methodPill(cov?.method)}</td>
                      <td className="hint" style={{ whiteSpace: 'normal' }}>
                        {cov ? (
                          <>
                            {cov.outcome ? <b>{cov.outcome}</b> : null} {cov.summary}{' '}
                            <span style={{ opacity: 0.7 }}>· {cov.source}</span>
                          </>
                        ) : (
                          s.note
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: '1rem' }}>
            <button className="btn btn-sm" onClick={() => setRecOpen((v) => !v)}>
              {recOpen ? 'Cancel' : '+ Record coverage evidence'}
            </button>
            {recOpen && (
              <div
                className="attest"
                style={{ display: 'block', marginTop: '.6rem', background: 'var(--surface-2)' }}
              >
                <p className="hint" style={{ margin: '0 0 .6rem' }}>
                  Attach non-run evidence to any vector — an external bench verdict, a control
                  attestation (e.g. BCP38/uRPF), a modelled or replay judgement. No traffic is
                  emitted; this is read-only assurance, audited.
                </p>
                <div className="grid">
                  <div className="field">
                    <label>Vector</label>
                    <select value={recVector} onChange={(e) => setRecVector(e.target.value)}>
                      {scenarios.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Method</label>
                    <select
                      value={recMethod}
                      onChange={(e) => setRecMethod(e.target.value as CoverageMethod)}
                    >
                      {RECORDABLE_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m.replace('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>
                      Outcome <span className="hint">(optional, e.g. PASS / MITIGATED)</span>
                    </label>
                    <input value={recOutcome} onChange={(e) => setRecOutcome(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>
                      Source <span className="hint">(e.g. network-team-bench)</span>
                    </label>
                    <input value={recSource} onChange={(e) => setRecSource(e.target.value)} />
                  </div>
                  <div className="field" style={{ gridColumn: '1 / -1' }}>
                    <label>Evidence / rationale</label>
                    <input
                      value={recSummary}
                      onChange={(e) => setRecSummary(e.target.value)}
                      placeholder="e.g. Edge enforces BCP38/uRPF; spoofed sources dropped."
                    />
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: '.6rem' }}
                  onClick={recordCoverage}
                  disabled={busy || !recVector || !recSummary.trim()}
                >
                  {busy ? 'Recording…' : 'Record coverage'}
                </button>
              </div>
            )}
          </div>

          {checklists.length > 0 && (
            <div style={{ marginTop: '.75rem' }}>
              <button className="btn btn-sm" onClick={() => setAttOpen((v) => !v)}>
                {attOpen ? 'Cancel' : '+ Attestation checklist'}
              </button>
              {attOpen && (
                <div
                  className="attest"
                  style={{ display: 'block', marginTop: '.6rem', background: 'var(--surface-2)' }}
                >
                  <p className="hint" style={{ margin: '0 0 .6rem' }}>
                    Structured control attestation for out-of-model vectors. Tick the controls
                    actually enforced at the edge; the bench derives a deterministic{' '}
                    <b>PASS / PARTIAL / FAIL</b> outcome and records it as <b>ATTESTED</b> coverage.
                    No traffic is emitted.
                  </p>
                  <div className="field" style={{ marginBottom: '.6rem' }}>
                    <label>Checklist</label>
                    <select
                      value={attId}
                      onChange={(e) => {
                        setAttId(e.target.value);
                        setAttChecked(new Set());
                      }}
                    >
                      {checklists.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title} → {c.vector}
                        </option>
                      ))}
                    </select>
                  </div>
                  {activeChecklist && (
                    <>
                      <p className="hint" style={{ margin: '0 0 .5rem' }}>
                        <b>{activeChecklist.standard}</b> — {activeChecklist.guidance}
                      </p>
                      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 .5rem' }}>
                        {activeChecklist.items.map((it) => (
                          <li key={it.id} style={{ padding: '.15rem 0' }}>
                            <label
                              style={{
                                display: 'flex',
                                gap: '.5rem',
                                alignItems: 'flex-start',
                                cursor: 'pointer',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={attChecked.has(it.id)}
                                onChange={() => toggleAtt(it.id)}
                                style={{ marginTop: '.2rem' }}
                              />
                              <span>
                                {it.label}
                                {it.required ? (
                                  <span style={{ color: 'var(--danger)' }}> *</span>
                                ) : (
                                  <span className="hint"> (optional)</span>
                                )}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      <p className="hint" style={{ margin: '0 0 .5rem' }}>
                        Preview:{' '}
                        <b>
                          {attChecked.size === 0
                            ? 'FAIL'
                            : activeChecklist.items
                                  .filter((i) => i.required)
                                  .every((i) => attChecked.has(i.id))
                              ? 'PASS'
                              : 'PARTIAL'}
                        </b>{' '}
                        · {attChecked.size}/{activeChecklist.items.length} controls
                      </p>
                      <div className="field" style={{ marginBottom: '.6rem' }}>
                        <label>
                          Note <span className="hint">(optional)</span>
                        </label>
                        <input
                          value={attNote}
                          onChange={(e) => setAttNote(e.target.value)}
                          placeholder="e.g. verified against edge running-config 2026-09-01"
                        />
                      </div>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={submitAttestation}
                        disabled={busy}
                      >
                        {busy ? 'Recording…' : 'Record attestation'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: '.75rem' }}>
            <button className="btn btn-sm" onClick={() => setImpOpen((v) => !v)}>
              {impOpen ? 'Cancel' : '+ Import external verdicts'}
            </button>
            {impOpen && (
              <div
                className="attest"
                style={{ display: 'block', marginTop: '.6rem', background: 'var(--surface-2)' }}
              >
                <p className="hint" style={{ margin: '0 0 .6rem' }}>
                  Bulk-import the network team&apos;s real L3/4 bench results as read-only{' '}
                  <b>INGESTED_EXTERNAL</b> coverage — the honest source for the out-of-model vectors
                  they own. Nothing is executed or emitted; invalid rows are reported, not dropped.
                </p>
                <div className="btn-row" style={{ marginBottom: '.6rem' }}>
                  <div className="field" style={{ minWidth: 120 }}>
                    <label>Format</label>
                    <select
                      value={impFormat}
                      onChange={(e) => setImpFormat(e.target.value as 'json' | 'csv')}
                    >
                      <option value="csv">CSV</option>
                      <option value="json">JSON</option>
                    </select>
                  </div>
                  <div className="field" style={{ flex: 1, minWidth: 200 }}>
                    <label>
                      Source <span className="hint">(default: network-team-bench)</span>
                    </label>
                    <input value={impSource} onChange={(e) => setImpSource(e.target.value)} />
                  </div>
                </div>
                <div className="field">
                  <label>
                    {impFormat === 'csv'
                      ? 'CSV — header: vector,outcome,drs,summary,source'
                      : 'JSON — array of { vector, outcome?, drs?, summary, source? }'}
                  </label>
                  <textarea
                    value={impData}
                    onChange={(e) => setImpData(e.target.value)}
                    rows={6}
                    style={{ fontFamily: 'var(--mono)', fontSize: '.82rem' }}
                    placeholder={
                      impFormat === 'csv'
                        ? 'vector,outcome,drs,summary,source\nip_spoofing,MITIGATED,4,"BCP38 upstream, spoofed sources dropped",acme-scrubbing'
                        : '[{"vector":"gre_packets","outcome":"MITIGATED","drs":5,"summary":"GRE dropped at edge","source":"acme-scrubbing"}]'
                    }
                  />
                </div>
                {impErrors.length > 0 && (
                  <ul className="hint" style={{ margin: '.3rem 0', color: 'var(--danger)' }}>
                    {impErrors.slice(0, 10).map((e) => (
                      <li key={e.row}>
                        row {e.row}: {e.error}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: '.6rem' }}
                  onClick={importCoverage}
                  disabled={busy || !impData.trim()}
                >
                  {busy ? 'Importing…' : 'Import verdicts'}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <p className="hint" style={{ marginTop: '.75rem' }}>
        Mapped to zeroBS report <b>P25-20300</b> (Volumetric section). Out-of-model vectors (TCP/GRE
        stateful floods, IP spoofing, fragmentation) are shown for coverage but can never be
        dispatched — spoofing is never permitted here by construction. The report&apos;s Layer-7
        vectors live in the control plane&apos;s playbooks. These verdicts are class C, read-only
        evidence — not the class-A/B DRS validations recorded via <code>/api/drs-validations</code>.
      </p>
    </div>
  );
}

function NotificationsCard() {
  const app = useApp();
  const [testing, setTesting] = useState(false);
  const configured = app.notifications.length > 0;
  const canTest = canDo(app.role, 'create', app.authRequired);
  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await api.notifyTest();
      app.push('success', `Test notification sent to: ${r.sinks.join(', ')}`);
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="card">
      <h2>Notifications</h2>
      <div className="kv">
        <div>
          <span className="k">Status</span>
          <span className="v">
            {configured ? (
              <span className="engine-badge ok">On</span>
            ) : (
              <span className="engine-badge no">Off</span>
            )}
          </span>
        </div>
        <div>
          <span className="k">Sinks</span>
          <span className="v">
            <code>{configured ? app.notifications.join(', ') : '—'}</code>
          </span>
        </div>
      </div>
      <p className="hint" style={{ marginTop: '.75rem' }}>
        The control plane can push a message to your team when a campaign completes, a run is
        killed, or a target&apos;s WRS regresses. Sinks (a Slack incoming webhook and/or a generic
        JSON webhook) are configured server-side via <code>NOTIFY_SLACK_WEBHOOK_URL</code> /{' '}
        <code>NOTIFY_WEBHOOK_URL</code>. See <code>docs/notifications.md</code>.
      </p>
      {configured && canTest && (
        <button
          className="btn btn-sm btn-primary"
          onClick={sendTest}
          disabled={testing}
          style={{ marginTop: '.5rem' }}
        >
          {testing ? 'Sending…' : 'Send test notification'}
        </button>
      )}
    </div>
  );
}

export function SettingsPage() {
  const app = useApp();
  return (
    <>
      <PageHead title="Settings" sub="Control plane configuration (read-only on the client)." />
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Session</h2>
        {app.authRequired && app.identity ? (
          <div className="kv">
            <div>
              <span className="k">User</span>
              <span className="v">{app.identity.email}</span>
            </div>
            <div>
              <span className="k">Role</span>
              <span className="v">{roleLabel[app.identity.role]}</span>
            </div>
          </div>
        ) : (
          <div className="field" style={{ maxWidth: 360 }}>
            <label htmlFor="op">Operator (dev mode)</label>
            <input
              id="op"
              placeholder="first.last@wedos"
              value={app.operator}
              onChange={(e) => app.setOperator(e.target.value)}
            />
            <span className="hint">Used as author/approver while authentication is disabled.</span>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Engine &amp; security</h2>
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

      <NotificationsCard />

      <div className="card">
        <h2>Load engines</h2>
        <p className="hint" style={{ marginBottom: '.75rem' }}>
          Third-party generators are operated by the team and delegated to via adapters — all
          produce bounded HTTP load only. A campaign can pick any installed engine; unavailable ones
          must be installed on the server.
        </p>
        {app.agents.length === 0 ? (
          <span className="hint">No engine information available.</span>
        ) : (
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
        )}
      </div>
    </>
  );
}

// ---------- Guide ----------
const STEPS = [
  {
    n: 1,
    title: 'Create',
    body: 'The guided wizard walks you through it: pick an objective, choose an allowlisted target, and it recommends the best-fit template (a single test or a full assessment) based on the target\'s history, installed engines and the current limits. "Advanced" opens the full form. You attest you are authorized to test the target.',
  },
  {
    n: 2,
    title: 'Approve',
    body: 'A Security Officer (different from the author) approves the campaign. Approval is valid for 24 h.',
  },
  {
    n: 3,
    title: 'Execute',
    body: 'Run it manually or on a schedule. The bounded HTTP generator and the legitimate probe run in parallel, under a 3-level kill switch.',
  },
  {
    n: 4,
    title: 'Score & report',
    body: 'Get the WEDOS Resiliency Score (WRS) and an HTML/PDF report; track WRS history and regressions per target.',
  },
];

// How to read a WRS grade, and what to do about it.
const WRS_LEVELS: {
  level: WrsBreakdown['level'];
  range: string;
  meaning: string;
  action: string;
}[] = [
  {
    level: 'A+',
    range: '90–100',
    meaning: 'Excellent — the service absorbed the load with negligible impact.',
    action: 'Keep a recurring baseline check to catch regressions early.',
  },
  {
    level: 'A',
    range: '80–89',
    meaning: 'Strong resilience; minor degradation under load.',
    action: 'Good state. Re-test after significant infra or config changes.',
  },
  {
    level: 'B',
    range: '70–79',
    meaning: 'Acceptable, but detection/mitigation or availability has room to improve.',
    action: 'Review the breakdown; tune autoscaling/caching, then re-test.',
  },
  {
    level: 'C',
    range: '55–69',
    meaning: 'Noticeable impact on legitimate traffic during the run.',
    action: 'Investigate the weakest WRS component; plan a mitigation and re-test.',
  },
  {
    level: 'D',
    range: '40–54',
    meaning: 'Poor — availability dropped materially under a bounded, lawful load.',
    action: 'Prioritise remediation; verify protection/kill-switch timings.',
  },
  {
    level: 'F',
    range: '0–39',
    meaning: 'Failing — the service could not sustain the test.',
    action: 'Escalate; treat as a resilience defect before any production exposure.',
  },
];

export function GuidePage() {
  const app = useApp();
  const navigate = useNavigate();

  const use = (p: Preset) => {
    app.applyPreset(p);
    navigate('/campaigns');
  };

  return (
    <>
      <PageHead
        title="Guide"
        sub="How a campaign works, and ready-made configurations you can apply in one click."
      />

      <h2 className="section-title">The four steps</h2>
      <div className="steps">
        {STEPS.map((s) => (
          <div key={s.n} className="step">
            <div className="step-n">{s.n}</div>
            <div>
              <div className="step-title">{s.title}</div>
              <div className="step-body">{s.body}</div>
            </div>
          </div>
        ))}
      </div>

      <h2 className="section-title">Reading the WRS</h2>
      <div className="card">
        <p className="subtitle" style={{ marginBottom: '.75rem' }}>
          The <b>WEDOS Resiliency Score</b> (0–100) blends detection, mitigation, availability and
          collateral impact (<code>WRS = 0.20·D + 0.30·M + 0.30·A + 0.20·C</code>). Higher is
          better. A drop of more than 10 points versus the previous run on the same target is
          flagged as a <b>regression</b> (and can notify your team).
        </p>
        <div className="wrs-legend">
          {WRS_LEVELS.map((l) => (
            <div key={l.level} className="wrs-legend-row">
              <span className={`wrs ${wrsClass(l.level)}`}>
                <span className="wrs-score">{l.range}</span> {l.level}
              </span>
              <div className="wrs-legend-text">
                <div>{l.meaning}</div>
                <div className="hint">{l.action}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="hint" style={{ marginTop: '.75rem' }}>
          When there is no protection integration, Detection and Mitigation are conservative
          estimates (the report marks the score as <i>estimated</i>). Focus on the lowest component
          in the breakdown to decide what to improve first.
        </p>
      </div>

      <h2 className="section-title">Recommended configurations</h2>
      <p className="subtitle" style={{ marginBottom: '.75rem' }}>
        Grouped by intent. Each preset sets the load shape and a recommended engine (used if
        installed, otherwise the server default) — never the target — and stays well within the
        safety caps. Start low, then increase gradually.
      </p>
      {PRESET_CATEGORIES.map((cat) => {
        const items = PRESETS.filter((p) => p.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="preset-group">
            <h3 className="preset-cat">{cat}</h3>
            <div className="preset-cards">
              {items.map((p) => {
                const eng = app.agents.find((a) => a.id === p.recommendedAgent);
                return (
                  <div key={p.id} className="preset-card">
                    <div className="preset-head">
                      <span className="preset-icon" aria-hidden="true">
                        {p.icon}
                      </span>
                      <span className="preset-name">{p.name}</span>
                    </div>
                    <p className="preset-summary">{p.summary}</p>
                    <p className="preset-when">{p.when}</p>
                    <div className="preset-specs">
                      <span>
                        <b>{p.maxRps}</b> rps
                      </span>
                      <span>
                        <b>{p.concurrency}</b> conc
                      </span>
                      <span>
                        <b>{p.maxDurationSec}</b>s
                      </span>
                      <span className="preset-profile">{p.profile}</span>
                    </div>
                    <div className="preset-est">
                      ≈ {formatCount(estimatedRequests(p.maxRps, p.maxDurationSec, p.profile))}{' '}
                      requests · engine <b>{p.recommendedAgent}</b>
                      {eng && !eng.available ? ' (not installed → default)' : ''}
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={() => use(p)}>
                      Use this configuration →
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <h2 className="section-title">Load engines</h2>
      <div className="card">
        <p className="subtitle" style={{ marginBottom: '.75rem' }}>
          Every campaign runs on a <b>load engine</b>. The built-in one needs nothing installed; the
          others delegate to team-operated tools (k6, Vegeta, Locust, JMeter, Gatling). All produce{' '}
          <b>bounded HTTP</b> load only — no volumetric or exhaustion vector. Pick one per campaign
          in the form; engines not installed on the server are greyed out, and constant-only engines
          can't run ramp/wave profiles.
        </p>
        {app.agents.length === 0 ? (
          <span className="hint">No engine information available.</span>
        ) : (
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
        )}
        <p className="hint" style={{ marginTop: '.75rem' }}>
          Installed status is also shown in <b>Settings → Load engines</b>. To enable an external
          engine, install its binary on the server; it then becomes selectable here.
        </p>
      </div>

      <div className="card" style={{ marginTop: '1.25rem' }}>
        <h2>Safety reminders</h2>
        <ul className="guide-list">
          <li>Only allowlisted targets can be tested; everything else is rejected server-side.</li>
          <li>
            Hard caps apply to every run: ≤ 2000 rps, ≤ 500 concurrent, ≤ 900 s (15 min absolute
            timeout).
          </li>
          <li>
            The manual <b>kill switch</b> is always available during a run — use it if the target
            starts to struggle.
          </li>
          <li>Keep an eye on the probe (5xx rate, availability) while a campaign runs.</li>
        </ul>
      </div>
    </>
  );
}
