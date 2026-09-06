import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, complianceUrl, reportUrl, runsCsvUrl, suiteReportUrl } from './api.js';
import type { Campaign, ManagedUser, Playbook, Role, SuiteSummary, WrsBreakdown } from './api.js';
import { useApp, canDo } from './context.js';
import {
  ApproveModal,
  CampaignCard,
  CampaignDrawer,
  ExecuteModal,
  NewCampaignForm,
  VerdictBadge,
  WrsPill,
  WrsTrend,
  hostOf,
  wrsClass,
} from './ui.js';
import { PRESETS, PRESET_CATEGORIES, estimatedRequests, formatCount } from './presets.js';
import type { Preset } from './presets.js';
import { getTheme, setTheme as persistTheme } from './theme.js';
import type { Theme } from './theme.js';

const roleLabel: Record<Role, string> = {
  officer: 'Security Officer',
  engineer: 'Security Engineer',
  viewer: 'SOC / NOC',
};

// ---------- sidebar + layout ----------
const NAV = [
  { to: '/', label: 'Overview', icon: '▚', end: true },
  { to: '/campaigns', label: 'Campaigns', icon: '◇', end: false },
  { to: '/reports', label: 'Reports', icon: '▤', end: false },
  { to: '/audit', label: 'Audit log', icon: '☰', end: false },
  { to: '/guide', label: 'Guide', icon: '❔', end: false },
  { to: '/settings', label: 'Settings', icon: '⚙', end: false },
];

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

export function Layout() {
  const app = useApp();
  const { toasts } = app;
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
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <span className="nav-icon" aria-hidden="true">
                  {n.icon}
                </span>
                {n.label}
              </NavLink>
            ))}
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
          </div>
        </aside>

        <main className="main">
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

function PageHead({ title, sub }: { title: string; sub?: React.ReactNode }) {
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
    match: (c) => ['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL'].includes(c.status),
  },
  { id: 'rejected', label: 'Rejected', match: (c) => c.status === 'REJECTED' },
];
type SortId = 'recent' | 'name' | 'wrs';

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

      {canCreate && !showForm && (
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            ＋ New campaign
          </button>
        </div>
      )}
      {showForm && <NewCampaignForm onDone={() => setShowForm(false)} />}

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
function SuitesSection() {
  const [suites, setSuites] = useState<SuiteSummary[]>([]);
  const app = useApp();
  useEffect(() => {
    api
      .suites()
      .then(setSuites)
      .catch(() => undefined);
    // Re-read when the campaign list changes (new suites / new scores).
  }, [app.campaigns]);
  if (suites.length === 0) return null;
  return (
    <>
      <h2 className="section-title">Assessment suites</h2>
      <div className="card" style={{ display: 'grid', gap: '.75rem', marginBottom: '1rem' }}>
        {suites.map((s) => (
          <div key={s.suiteId} className="wrs-hist">
            <div className="wrs-hist-main">
              <b>{s.suiteName}</b>
              <code>{s.target}</code>
              {s.wrs ? (
                <span className={`wrs ${wrsClass(s.wrs.level)}`} title="Aggregate: worst-step WRS">
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
              <a
                className="btn btn-sm btn-ghost"
                href={suiteReportUrl(s.suiteId)}
                target="_blank"
                rel="noreferrer"
              >
                Suite report ↗
              </a>
            </div>
            <div className="suite-steps">
              {s.members.map((m) => (
                <span key={m.id} className="chip-xs" title={m.status}>
                  {m.order + 1}. {m.name.split(' — ').pop()}
                  {m.wrs != null ? ` · ${m.wrs} ${m.level}` : ''}
                </span>
              ))}
            </div>
          </div>
        ))}
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

// ---------- Audit log ----------
export function AuditPage() {
  const app = useApp();
  const { loadAudit } = app;
  useEffect(() => {
    loadAudit();
  }, [loadAudit]);
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
        </div>
        <p className="hint" style={{ marginTop: '.75rem' }}>
          Bounded HTTP generator only (GET/POST, rate-capped, allowlisted). No volumetric or
          exhaustion vector is implemented. The allowlist and the default agent are configured
          server-side (environment variables).
        </p>
      </div>

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
    body: 'Fill the new-campaign form (or start from a preset), and pick a load engine. Target and probe must be in the allowlist; you attest you are authorized to test them.',
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

function PlaybooksSection() {
  const app = useApp();
  const navigate = useNavigate();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [target, setTarget] = useState('');
  const [recurMin, setRecurMin] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const emptyNew = { name: '', category: 'Custom', summary: '', when: '', stepsJson: '' };
  const [newPb, setNewPb] = useState({ ...emptyNew });

  const load = () => {
    api
      .playbooks()
      .then(setPlaybooks)
      .catch(() => undefined);
  };
  useEffect(load, []);

  const canCreate = canDo(app.role, 'create', app.authRequired);

  const createPlaybook = async () => {
    try {
      const steps = JSON.parse(newPb.stepsJson || '[]');
      await api.createPlaybook({
        name: newPb.name,
        category: newPb.category,
        summary: newPb.summary,
        when: newPb.when,
        steps,
      });
      app.push('success', `Playbook "${newPb.name}" created.`);
      setNewPb({ ...emptyNew });
      setShowNew(false);
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };
  const removePlaybook = async (pb: Playbook) => {
    try {
      await api.deletePlaybook(pb.id);
      app.push('success', `Playbook "${pb.name}" deleted.`);
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };
  const targetHost = hostOf(target);
  const targetAllowed = targetHost !== null && app.allowed.includes(targetHost);

  const launch = async (pb: Playbook) => {
    if (!targetAllowed) return;
    setBusy(pb.id);
    try {
      const r = await api.instantiatePlaybook(pb.id, {
        target,
        recurrenceMin: recurMin ? Number(recurMin) : undefined,
      });
      app.push(
        'success',
        `Assessment "${pb.name}" created — ${r.campaigns.length} campaigns (pending approval).`,
      );
      await app.refresh();
      navigate('/campaigns');
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (playbooks.length === 0) return null;

  return (
    <>
      <h2 className="section-title">Assessment playbooks</h2>
      <p className="subtitle" style={{ marginBottom: '.75rem' }}>
        One-click curated sequences of bounded campaigns. Pick a target, launch, and the whole
        assessment is created — each campaign still goes through approval before it runs.
      </p>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="field">
          <label>Target for the assessment</label>
          <input
            placeholder="https://staging.example.com/"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          {app.allowed.length > 0 && (
            <div className="allowed-chips">
              {app.allowed.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="chip-xs"
                  onClick={() => setTarget(`https://${h}/`)}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
          {target && !targetAllowed && (
            <span className="hint">Host is not in the allowlist — pick one above.</span>
          )}
        </div>
        <div className="field">
          <label>Repeat the assessment (optional)</label>
          <select value={recurMin} onChange={(e) => setRecurMin(e.target.value)}>
            <option value="">Run once</option>
            <option value="60">Every hour</option>
            <option value="360">Every 6 hours</option>
            <option value="720">Every 12 hours</option>
          </select>
          <span className="hint">
            Each campaign re-runs on this cadence, within its 24 h approval window.
          </span>
        </div>
      </div>
      <div className="preset-cards">
        {playbooks.map((pb) => (
          <div key={pb.id} className="preset-card">
            <div className="preset-head">
              <span className="preset-name">{pb.name}</span>
              {pb.custom && <span className="engine-badge ok">custom</span>}
            </div>
            <p className="preset-summary">{pb.summary}</p>
            <p className="preset-when">{pb.when}</p>
            <ol className="playbook-steps">
              {pb.steps.map((s, i) => (
                <li key={i}>
                  <b>{s.name}</b> — {s.maxRps} rps · {s.maxDurationSec}s · {s.profile}
                </li>
              ))}
            </ol>
            {canCreate && (
              <div className="btn-row">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!targetAllowed || busy === pb.id}
                  onClick={() => launch(pb)}
                >
                  {busy === pb.id ? 'Launching…' : `Launch assessment (${pb.steps.length}) →`}
                </button>
                {pb.custom && (
                  <button className="btn btn-sm btn-ghost" onClick={() => removePlaybook(pb)}>
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {canCreate && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="card-head">
            <h2>Custom playbook</h2>
            <button className="btn btn-sm" onClick={() => setShowNew((v) => !v)}>
              {showNew ? 'Cancel' : '＋ New playbook'}
            </button>
          </div>
          {showNew && (
            <div className="grid">
              <div className="field">
                <label>Name</label>
                <input
                  value={newPb.name}
                  onChange={(e) => setNewPb({ ...newPb, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Category</label>
                <input
                  value={newPb.category}
                  onChange={(e) => setNewPb({ ...newPb, category: e.target.value })}
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Summary</label>
                <input
                  value={newPb.summary}
                  onChange={(e) => setNewPb({ ...newPb, summary: e.target.value })}
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Steps (JSON)</label>
                <textarea
                  rows={7}
                  placeholder={
                    '[\n  {"name":"Baseline","maxRps":100,"concurrency":20,"maxDurationSec":120,"profile":"constant","agent":"vegeta"},\n  {"name":"Ramp","maxRps":300,"concurrency":50,"maxDurationSec":180,"profile":"ramp","agent":"k6"}\n]'
                  }
                  value={newPb.stepsJson}
                  onChange={(e) => setNewPb({ ...newPb, stepsJson: e.target.value })}
                  style={{ fontFamily: 'var(--mono, monospace)' }}
                />
                <span className="hint">
                  Each step: <code>name, maxRps, concurrency, maxDurationSec, profile</code>{' '}
                  (constant/ramp/wave), optional <code>agent</code>. All within the caps.
                </span>
              </div>
              <div className="field" style={{ alignSelf: 'end' }}>
                <button
                  className="btn btn-primary"
                  disabled={!newPb.name.trim() || !newPb.stepsJson.trim()}
                  onClick={createPlaybook}
                >
                  Save playbook
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

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

      <PlaybooksSection />

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
