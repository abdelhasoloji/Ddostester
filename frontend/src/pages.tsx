import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { complianceUrl, reportUrl } from './api.js';
import type { Role, WrsBreakdown } from './api.js';
import { useApp } from './context.js';
import {
  ApproveModal,
  CampaignCard,
  ExecuteModal,
  NewCampaignForm,
  Sparkline,
  WrsPill,
} from './ui.js';

const roleLabel: Record<Role, string> = {
  officer: 'Security Officer',
  engineer: 'Security Engineer',
  viewer: 'SOC / NOC',
};

function wrsClass(level: WrsBreakdown['level']): string {
  return 'wrs-' + level.replace('+', 'p');
}

// ---------- sidebar + layout ----------
const NAV = [
  { to: '/', label: 'Overview', icon: '▚', end: true },
  { to: '/campaigns', label: 'Campaigns', icon: '◇', end: false },
  { to: '/reports', label: 'Reports', icon: '▤', end: false },
  { to: '/audit', label: 'Audit log', icon: '☰', end: false },
  { to: '/settings', label: 'Settings', icon: '⚙', end: false },
];

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
                · agent <code>{app.agentName}</code>
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
                <Sparkline points={s.points} regression={s.regression} />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------- Campaigns ----------
export function CampaignsPage() {
  const app = useApp();
  return (
    <>
      <PageHead title="Campaigns" sub={app.anyRunning ? 'Auto-refreshing…' : undefined} />
      <NewCampaignForm />
      <h2 className="section-title">Campaign list</h2>
      <div className="campaigns">
        {app.campaigns.length === 0 && <div className="empty">No campaigns yet.</div>}
        {app.campaigns.map((c) => (
          <CampaignCard key={c.id} c={c} />
        ))}
      </div>
    </>
  );
}

// ---------- Reports ----------
export function ReportsPage() {
  const app = useApp();
  const withRun = app.campaigns.filter((c) => c.runId);
  return (
    <>
      <PageHead
        title="Reports"
        sub="Campaign reports (HTML/PDF) and aggregated DORA / NIS2 compliance."
      />
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Aggregated compliance</h2>
        <p className="hint">
          Summary of every executed campaign, aligned with operational resilience (DORA) and risk
          management (NIS2) requirements.
        </p>
        <a className="btn btn-primary" href={complianceUrl()} target="_blank" rel="noreferrer">
          Open compliance report ↗
        </a>
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
            <span className="k">Allowed targets</span>
            <span className="v">
              <code>{app.allowed.join(', ') || '—'}</code>
            </span>
          </div>
        </div>
        <p className="hint" style={{ marginTop: '.75rem' }}>
          Bounded HTTP generator only (GET/POST, rate-capped, allowlisted). No volumetric or
          exhaustion vector is implemented. The allowlist and the agent are configured server-side
          (environment variables).
        </p>
      </div>
    </>
  );
}
