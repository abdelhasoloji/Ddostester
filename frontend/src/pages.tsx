import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  api,
  auditExportUrl,
  complianceUrl,
  compareUrl,
  reportUrl,
  runsCsvUrl,
  suiteReportUrl,
  suiteCompareUrl,
  getGrafanaBase,
  setGrafanaBase,
  grafanaDashUrl,
} from './api.js';
import type {
  Alert,
  GrafanaPlane,
  AttestationChecklist,
  AuditVerdict,
  BenchCatalogue,
  BenchCoverage,
  BenchRun,
  CoverageMethod,
  Campaign,
  CampaignRun,
  CampaignStatus,
  AbsorptionSummaryRow,
  HardCaps,
  ManagedUser,
  Role,
  SuiteSummary,
  SuiteSequenceState,
  ReconReport,
  WrsBreakdown,
  ControlKey,
  ControlStatus,
  ProtectionProfile,
  InferredProfile,
  NetworkLadder,
  GapAnalysis,
  Priority,
  RunComparison,
} from './api.js';
import { RECORDABLE_METHODS, GAP_CONTROLS } from './api.js';
import { useApp, canDo } from './context.js';
import { APP_VERSION_LABEL, APP_BUILT, APP_COMMIT } from './version.js';
import {
  ApproveModal,
  CampaignCard,
  CampaignDrawer,
  ChangePasswordForm,
  ExecuteModal,
  NewCampaignForm,
  NewCampaignWizard,
  StatusBadge,
  VerdictBadge,
  WrsPill,
  WrsTrend,
  wrsClass,
  AbsorptionWidget,
  ConfidenceBadge,
  RunTheater,
  RunDetails,
  hostOf,
} from './ui.js';
import { PRESETS, PRESET_CATEGORIES, estimatedRequests, formatCount } from './presets.js';
import type { Preset } from './presets.js';
import { getTheme, setTheme as persistTheme } from './theme.js';
import type { Theme } from './theme.js';

const roleLabel: Record<Role, string> = {
  engineer: 'Security Engineer',
  ciso: 'CISO',
  admin: 'Administrator',
  viewer: 'SOC / NOC',
};

// ---------- sidebar + layout ----------
// Campaign orchestration is the whole point of the tool, so it is the single
// primary destination (the home page). Everything else — the assessment phases,
// templates, reports, audit, guide and settings — stays one click away under a
// collapsible "More" menu, keeping the sidebar focused instead of a flat list.
// v2 — the resilience spine: land on status (Command Center), then the workflow
// arc (Prepare → Campaigns → Results) and governance (Assurance). Secondary
// destinations stay reachable under "More"; Guide/Settings live in the foot.
// The primary navigation — the resilience spine, then governance. Everything a
// campaign needs (Templates, Plan, the guide) lives inside the Campaigns
// workspace, so the sidebar stays a flat, focused list with Settings on it too.
// One distinct emoji per destination — no repeats, no lone geometric glyph, so
// the eight links stay tellable apart at a glance.
const SPINE_NAV = [
  { to: '/', label: 'Command Center', icon: '🛰', end: true },
  { to: '/zones', label: 'Protected zones', icon: '🛡' },
  { to: '/prepare', label: 'Prepare', icon: '🔍' },
  { to: '/campaigns', label: 'Campaigns', icon: '🎯' },
  { to: '/theater', label: 'Run Theater', icon: '🎬' },
  { to: '/reports', label: 'Results', icon: '📊' },
  { to: '/audit', label: 'Assurance', icon: '⚖' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
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

// Must match the WRS bands documented in the guide (WRS_LEVELS): C 55–69,
// D 40–54, F 0–39 — so the Command Center pill never disagrees with the legend.
const gradeFromScore = (n: number): WrsBreakdown['level'] =>
  n >= 90 ? 'A+' : n >= 80 ? 'A' : n >= 70 ? 'B' : n >= 55 ? 'C' : n >= 40 ? 'D' : 'F';

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
        No approvals waiting. Governance &amp; tamper-evident evidence in{' '}
        <Link to="/audit">Assurance →</Link>
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
        Read-only access. Watch live in <Link to="/theater">Run Theater</Link> or review{' '}
        <Link to="/reports">Results</Link>.
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
      <div className="section-title">Absorption by attack shape</div>
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
      ? { runId: fallback.runId!, name: fallback.name, target: fallback.target, wrs: fallback.wrs! }
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
            Fleet resilience · {scored.length} target{scored.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{running.length}</div>
          <div className="kpi-k">Runs in flight</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">
            <span className={`health-pill health-${health}`}>{health}</span>
          </div>
          <div className="kpi-k">Generator health</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{alerts.length}</div>
          <div className="kpi-k">Active alerts</div>
        </div>
      </div>

      <RoleFocus />

      {alerts.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="section-title">Active alerts · from recent runs</div>
          <ul className="alerts-list">
            {alerts.slice(0, 6).map((a) => (
              <li key={a.key} className={`alert-row alert-${a.severity}`}>
                <button
                  type="button"
                  className="alert-row-btn"
                  onClick={() => openAlert(a)}
                  title="Open the related campaign / run"
                >
                  <span className="alert-dot" aria-hidden="true" />
                  <span className="alert-title">{a.title}</span>
                  <span className="alert-detail">{a.detail}</span>
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
function useSuiteSequences(onActiveTick?: () => void): Record<string, SuiteSequenceState> {
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
function shortStepName(n: string): string {
  const parts = n.split('—').map((s) => s.trim());
  return parts.length > 2 ? parts.slice(2).join(' — ') : parts[parts.length - 1] || n;
}

const SUITE_TERMINAL: CampaignStatus[] = [
  'COMPLETED',
  'KILLED_AUTO',
  'KILLED_MANUAL',
  'CANCELLED',
  'REJECTED',
];

/** Recon posture of the suite's target — what the assessment is up against.
 *  Foregrounds the reconnaissance the tool already performed (seeded paths,
 *  edge posture, preflight verdict). */
function ReconStrip({
  recon,
  loading,
  onOpen,
}: {
  recon: ReconReport | null;
  loading: boolean;
  onOpen?: () => void;
}) {
  if (!recon) {
    return (
      <div className="recon-strip">
        <span className="recon-label">🔎 Recon</span>
        <span className="hint">
          {loading ? (
            <>
              <span className="spin" /> profiling target…
            </>
          ) : (
            'unavailable'
          )}
        </span>
      </div>
    );
  }
  const p = recon.profile.posture;
  const edge: { k: string; on: boolean }[] = [
    { k: 'WAF', on: p.waf },
    { k: 'CDN', on: p.cdn },
    { k: 'Rate-limit', on: p.rateLimiting },
    { k: 'Load-balancer', on: p.loadBalancer },
  ];
  const seeded = recon.suggestedPaths?.length ?? 0;
  return (
    <button
      type="button"
      className="recon-strip clickable"
      onClick={onOpen}
      title="Open the full target intelligence"
    >
      <span className="recon-label">🔎 Recon</span>
      {p.server && <span className="recon-chip srv">{p.server}</span>}
      {recon.profile.protocols?.http2 && <span className="recon-chip srv">HTTP/2</span>}
      {edge.map((c) => (
        <span key={c.k} className={`recon-chip ${c.on ? 'on' : 'off'}`}>
          {c.on ? '✓' : '✗'} {c.k}
        </span>
      ))}
      {seeded > 0 && <span className="recon-chip paths">{seeded} seeded path(s)</span>}
      {recon.loginPath && <span className="recon-chip login">login {recon.loginPath}</span>}
      <span className={`recon-chip ${recon.preflight.go ? 'go' : 'nogo'}`}>
        {recon.preflight.go ? 'preflight GO' : '⚠ preflight NO-GO'}
      </span>
      <span className="recon-more">full intel →</span>
    </button>
  );
}

/** Humanised labels for the inferred defense controls (seededProfile). */
const CONTROL_LABELS: Record<string, string> = {
  synFloodProtection: 'SYN-flood protection',
  slowRequestTimeout: 'Slow-request timeout',
  rateLimiting: 'Rate limiting',
  originShielding: 'Origin shielding',
  cacheKeyPolicy: 'Cache-key policy',
  urlAllowlist: 'URL allowlist',
  methodPolicy: 'Method policy',
  http2Guard: 'HTTP/2 guard',
  challenge: 'Challenge / JS / CAPTCHA',
  wafSignatures: 'WAF signatures',
  bruteForceProtection: 'Brute-force protection',
};

/** The full target-intelligence dossier — every field recon returns, laid out
 *  as a scannable dossier. Opened from the recon strip. */
function ReconDetailModal({ recon, onClose }: { recon: ReconReport; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const p = recon.profile;
  const post = p.posture;
  const b = recon.baseline;
  const host = hostOf(recon.target) ?? recon.target;
  const yn = (v: boolean) => (v ? 'yes' : 'no');
  const fingerprint: { k: string; v: string; on?: boolean }[] = [
    { k: 'Server', v: post.server || p.server || '—' },
    { k: 'Vendor', v: p.vendor || '—' },
    { k: 'TLS', v: p.tls || '—' },
    { k: 'HTTP/2', v: yn(p.protocols?.http2), on: p.protocols?.http2 },
    { k: 'HTTP/3', v: yn(p.protocols?.http3), on: p.protocols?.http3 },
    { k: 'Cache', v: p.cache ?? 'unknown' },
  ];
  const edge: { k: string; on: boolean }[] = [
    { k: 'WAF', on: post.waf },
    { k: 'CDN', on: post.cdn },
    { k: 'Rate limiting', on: post.rateLimiting },
    { k: 'Load balancer', on: post.loadBalancer },
    { k: 'HSTS', on: post.hsts },
  ];
  const controls = Object.entries(recon.seededProfile ?? {});
  const paths = recon.suggestedPaths ?? recon.surface?.paths ?? [];

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal recon-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Target intelligence for ${host}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="recon-modal-head">
          <div>
            <h3>Target intelligence</h3>
            <span className="hint">
              <code>{host}</code>
              {recon.generatedAt ? ` · profiled ${relTime(recon.generatedAt)}` : ''}
            </span>
          </div>
          <span className={`recon-verdict ${recon.preflight.go ? 'go' : 'nogo'}`}>
            {recon.preflight.go ? '✓ preflight GO' : '⚠ preflight NO-GO'}
          </span>
          <button className="recon-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="recon-modal-body">
          <section className="recon-sec">
            <h4>Fingerprint</h4>
            <div className="recon-kv-grid">
              {fingerprint.map((f) => (
                <div key={f.k} className="recon-kv">
                  <span className="rk">{f.k}</span>
                  <span className={`rv ${f.on === true ? 'good' : ''}`}>{f.v}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="recon-sec">
            <h4>Edge posture</h4>
            <div className="recon-chip-row">
              {edge.map((c) => (
                <span key={c.k} className={`recon-chip lg ${c.on ? 'on' : 'off'}`}>
                  {c.on ? '✓' : '✗'} {c.k}
                </span>
              ))}
            </div>
            {post.signals?.length > 0 && (
              <div className="recon-sub">
                <span className="rk">Signals</span>
                <div className="recon-chip-row">
                  {post.signals.map((s, i) => (
                    <span key={i} className="recon-chip sig">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {post.securityHeaders?.length > 0 && (
              <div className="recon-sub">
                <span className="rk">Security headers</span>
                <div className="recon-chip-row">
                  {post.securityHeaders.map((h) => (
                    <span key={h} className="recon-chip on mono">
                      {h}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="recon-sec">
            <h4>Baseline (pre-load)</h4>
            <div className="recon-stat-row">
              <div className="recon-stat">
                <div className="rs-v good">{b?.availabilityPct ?? 100}%</div>
                <div className="rs-k">availability</div>
              </div>
              <div className="recon-stat">
                <div className="rs-v">
                  {b?.latencyP50 != null ? `${Math.round(b.latencyP50)}ms` : '—'}
                </div>
                <div className="rs-k">p50 latency</div>
              </div>
              <div className="recon-stat">
                <div className="rs-v">
                  {b?.latencyP95 != null ? `${Math.round(b.latencyP95)}ms` : '—'}
                </div>
                <div className="rs-k">p95 latency</div>
              </div>
              <div className="recon-stat">
                <div className="rs-v">
                  {b?.latencyMean != null ? `${Math.round(b.latencyMean)}ms` : '—'}
                </div>
                <div className="rs-k">mean</div>
              </div>
              <div className="recon-stat">
                <div className="rs-v">{b?.samples ?? 0}</div>
                <div className="rs-k">samples</div>
              </div>
            </div>
          </section>

          {controls.length > 0 && (
            <section className="recon-sec">
              <h4>Inferred defense controls</h4>
              <div className="recon-ctrl-grid">
                {controls.map(([key, status]) => (
                  <div key={key} className="recon-ctrl">
                    <span className="rc-name">{CONTROL_LABELS[key] ?? key}</span>
                    <span className={`rc-status rc-${status}`}>{status}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="recon-sec">
            <h4>Attack surface</h4>
            {recon.loginPath && (
              <div className="recon-sub">
                <span className="rk">Login</span>
                <span className="recon-chip login mono">{recon.loginPath}</span>
              </div>
            )}
            {paths.length > 0 ? (
              <div className="recon-sub">
                <span className="rk">Seeded paths ({paths.length})</span>
                <div className="recon-chip-row wrap">
                  {paths.map((pt, i) => (
                    <span key={i} className="recon-chip path mono">
                      {pt}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="hint">No real paths discovered — templates in use.</p>
            )}
            {recon.surface?.sitemaps?.length > 0 && (
              <div className="recon-sub">
                <span className="rk">Sitemaps</span>
                <div className="recon-chip-row wrap">
                  {recon.surface.sitemaps.map((s, i) => (
                    <span key={i} className="recon-chip mono">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {recon.surface?.disallow?.length > 0 && (
              <div className="recon-sub">
                <span className="rk">robots.txt disallow</span>
                <div className="recon-chip-row wrap">
                  {recon.surface.disallow.map((s, i) => (
                    <span key={i} className="recon-chip off mono">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {recon.preflight.items?.length > 0 && (
            <section className="recon-sec">
              <h4>Preflight checklist</h4>
              <ul className="recon-preflight">
                {recon.preflight.items.map((it) => (
                  <li key={it.key} className={it.ok ? 'ok' : it.required ? 'fail' : 'warn'}>
                    <span className="pf-icon">{it.ok ? '✓' : it.required ? '✕' : '▲'}</span>
                    <span className="pf-body">
                      <b>{it.label}</b>
                      {!it.required && !it.ok && <span className="pf-opt"> (optional)</span>}
                      {it.detail && <span className="pf-detail">{it.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** The multi-step assessment as one live surface: a recon strip, a stepper that
 *  animates the wave in flight (and the recovery gate between waves), and the
 *  live protection panel for whichever step is running. Stays present between
 *  steps instead of collapsing to an empty "no run in flight". */
function SuiteTheater({
  seq,
  members,
  onKill,
  busy,
}: {
  seq?: SuiteSequenceState;
  members: Campaign[];
  onKill: (c: Campaign) => void;
  busy: Record<string, boolean>;
}) {
  const ordered = useMemo(
    () => [...members].sort((a, b) => (a.suiteOrder ?? 0) - (b.suiteOrder ?? 0)),
    [members],
  );
  const target = ordered[0]?.target ?? '';
  const suiteName = ordered[0]?.suiteName ?? 'Assessment suite';
  const runningStep = ordered.find((c) => c.status === 'RUNNING');
  const doneCount = ordered.filter((c) => SUITE_TERMINAL.includes(c.status)).length;
  const total = seq?.total ?? ordered.length;
  const seqActive = !!seq;
  // Between waves: the sequence is live but nothing is RUNNING yet — the
  // recovery gate is holding for the target to come back.
  const inGate = seqActive && !runningStep && doneCount < total && !seq?.paused;
  const nextStep = ordered.find(
    (c) => !SUITE_TERMINAL.includes(c.status) && c.status !== 'RUNNING',
  );
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  const [recon, setRecon] = useState<ReconReport | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconOpen, setReconOpen] = useState(false);
  useEffect(() => {
    if (!target) return;
    let alive = true;
    setReconLoading(true);
    api
      .recon(target)
      .then((r) => alive && setRecon(r))
      .catch(() => undefined)
      .finally(() => alive && setReconLoading(false));
    return () => {
      alive = false;
    };
  }, [target]);

  const phase = seq?.autoPaused
    ? 'down'
    : seq?.paused
      ? 'paused'
      : runningStep
        ? 'running'
        : inGate
          ? 'gate'
          : 'settling';

  return (
    <div className="suite-theater">
      <div className="stheater-head">
        <div className="stheater-id">
          <div className="stheater-title">{suiteName}</div>
          <span className="hint">
            {hostOf(target) ?? target} · {total} steps
          </span>
        </div>
        <div className="stheater-progress-wrap">
          <div className="stheater-progress-label">
            <b>
              {doneCount}/{total}
            </b>{' '}
            steps
            <span className={`phase-tag phase-${phase}`}>{phase}</span>
          </div>
          <div className="stheater-progress">
            <div className="stheater-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <ReconStrip recon={recon} loading={reconLoading} onOpen={() => setReconOpen(true)} />
      {reconOpen && recon && <ReconDetailModal recon={recon} onClose={() => setReconOpen(false)} />}

      <div className="stepper" role="list">
        {ordered.map((c, i) => {
          const isDone = SUITE_TERMINAL.includes(c.status);
          const isRun = c.status === 'RUNNING';
          const isGateHere = inGate && nextStep?.id === c.id;
          const state = isRun ? 'run' : isGateHere ? 'gate' : isDone ? 'done' : 'queued';
          const killed = c.status === 'KILLED_AUTO' || c.status === 'KILLED_MANUAL';
          return (
            <div key={c.id} className={`step-node step-${state}`} role="listitem">
              <div className="step-connector" aria-hidden="true" />
              <div className="step-dot">
                {isDone
                  ? c.status === 'COMPLETED'
                    ? '✓'
                    : killed
                      ? '◼'
                      : '✕'
                  : isRun
                    ? ''
                    : i + 1}
              </div>
              <div className="step-meta">
                <div className="step-name" title={c.name}>
                  {shortStepName(c.name)}
                </div>
                {c.wrs ? (
                  <span className={`wrs-pill ${wrsClass(c.wrs.level)}`}>
                    {c.wrs.wrs} {c.wrs.level}
                  </span>
                ) : isRun ? (
                  <span className="step-tag live">● live</span>
                ) : isGateHere ? (
                  <span className="step-tag gate">recovering…</span>
                ) : (
                  <span className="step-tag">queued</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {runningStep ? (
        <RunTheater
          campaignId={runningStep.id}
          name={shortStepName(runningStep.name)}
          target={runningStep.target}
          engine={runningStep.agent}
          vector={runningStep.vector}
          onKill={() => onKill(runningStep)}
          killing={busy[runningStep.id]}
        />
      ) : inGate ? (
        <div className="gate-card">
          <div className="gate-scan" aria-hidden="true" />
          <div className="gate-text">
            <div className="gate-title">Recovery gate</div>
            <p className="hint">
              Waiting for <code>{hostOf(target) ?? target}</code> to become reachable again before
              the next wave — the origin may still be recovering from the previous step.
              {nextStep && (
                <>
                  {' '}
                  Next: <b>{shortStepName(nextStep.name)}</b>.
                </>
              )}
            </p>
          </div>
        </div>
      ) : seq?.autoPaused ? (
        <div className="gate-card down">
          <div className="gate-text">
            <div className="gate-title">Origin appears down</div>
            <p className="hint">
              <code>{hostOf(target) ?? target}</code> stayed unreachable across {seq.downSkips ?? 2}{' '}
              recovery checks, so the sequence <b>auto-paused</b> to protect the target — it will
              not relaunch load onto a downed origin. Bring the origin back, then <b>resume</b> to
              continue the remaining steps.
            </p>
          </div>
        </div>
      ) : seq?.paused ? (
        <div className="gate-card paused">
          <div className="gate-text">
            <div className="gate-title">Sequence paused</div>
            <p className="hint">Resume from the campaigns view to continue the remaining steps.</p>
          </div>
        </div>
      ) : (
        <p className="hint" style={{ padding: '1rem' }}>
          Suite settling — finalising the last step.
        </p>
      )}
    </div>
  );
}

/**
 * v2 Run Theater page — a focused live surface for whatever is running now. For
 * a multi-step suite it shows the whole sequence (recon, a live stepper, and the
 * recovery gate between waves) so it never collapses to "no run" mid-suite;
 * standalone campaigns still get the single live panel.
 */
export function RunTheaterPage() {
  const app = useApp();
  // Refresh campaigns on each sequence poll while a suite is in flight, so the
  // theater advances through the recovery gate without a manual navigation.
  const seqs = useSuiteSequences(app.refresh);
  const running = app.campaigns.filter((c) => c.status === 'RUNNING');
  // An active suite = one with a live sequence, or (fallback) the suite of a
  // running step even if the poll hasn't landed yet.
  const activeSuiteId = Object.keys(seqs)[0] ?? running.find((c) => c.suiteId)?.suiteId;
  const suiteMembers = activeSuiteId
    ? app.campaigns.filter((c) => c.suiteId === activeSuiteId)
    : [];
  const hasSuite = !!activeSuiteId && suiteMembers.length > 0;

  // Standalone runs (not part of the active suite) keep the single-run tabs.
  // When no suite is active, every running campaign is standalone.
  const standalone = running.filter((c) => !(hasSuite && c.suiteId === activeSuiteId));
  const [active, setActive] = useState<string | null>(null);
  const current = standalone.find((c) => c.id === active) ?? standalone[0];

  const grafanaTarget = suiteMembers[0]?.target ?? current?.target;

  return (
    <>
      <PageHead
        title="Run Theater"
        sub="Watch protection engage in real time — offered load vs what reaches origin, and the share the edge absorbs."
      />
      {grafanaTarget && (
        <GrafanaLink
          plane="run"
          label="Open this run in Grafana"
          target={hostOf(grafanaTarget) ?? grafanaTarget}
        />
      )}
      {!hasSuite && standalone.length === 0 ? (
        <div className="card">
          <p className="muted">
            No run in flight. Launch one from <Link to="/campaigns">Campaigns</Link> and it appears
            here live.
          </p>
        </div>
      ) : (
        <>
          {hasSuite && (
            <div className="card suite-theater-card">
              <SuiteTheater
                seq={activeSuiteId ? seqs[activeSuiteId] : undefined}
                members={suiteMembers}
                onKill={app.kill}
                busy={app.busy}
              />
            </div>
          )}
          {standalone.length > 1 && (
            <div style={{ display: 'flex', gap: '.4rem', margin: '.8rem 0', flexWrap: 'wrap' }}>
              {standalone.map((c) => (
                <button
                  key={c.id}
                  className={`btn btn-sm ${current?.id === c.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActive(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {standalone.length > 0 && current && (
            <div className="card">
              <RunTheater
                campaignId={current.id}
                name={current.name}
                target={current.target}
                vector={current.vector}
                onKill={() => app.kill(current)}
                killing={app.busy[current.id]}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * A one-click deep link into the ShieldTest Grafana dashboard for a given
 * observability plane. Renders nothing until a Grafana base URL is configured
 * (Settings → Observability), so the app degrades gracefully without Grafana.
 */
function GrafanaLink({
  plane,
  label,
  target,
}: {
  plane: GrafanaPlane;
  label: string;
  target?: string;
}) {
  const base = getGrafanaBase();
  if (!base) return null;
  return (
    <div className="page-actions">
      <a
        className="btn btn-sm btn-ghost"
        href={grafanaDashUrl(base, plane, { target })}
        target="_blank"
        rel="noreferrer"
        title="Open the ShieldTest Grafana dashboard for this view"
      >
        📊 {label} ↗
      </a>
    </div>
  );
}

// ---------- Notifications (the alerts, reworked into a bell + panel) ----------

const ALERT_ICON: Record<Alert['kind'], string> = {
  tarpit: '🕳',
  'low-wrs': '📉',
  degraded: '📡',
  'auto-killed': '🛑',
  'not-engaging': '🚱',
  'wrs-regression': '⤵',
  'protection-regression': '⤵',
};
function alertIcon(kind: Alert['kind']): string {
  return ALERT_ICON[kind] ?? '🔔';
}

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago"). */
function relTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const NOTIF_READ_KEY = 'shieldtest.notif.read';
function loadReadKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIF_READ_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveReadKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...keys]));
  } catch {
    /* private mode / storage disabled — read-state is best-effort */
  }
}

/**
 * Navigate to what an alert is about: the owning campaign's detail drawer when
 * we still have it, otherwise the run's report. Shared by the bell panel and the
 * Command Center list so a notification is always actionable, never a dead line.
 */
function useOpenAlert(): (a: Alert) => void {
  const app = useApp();
  const navigate = useNavigate();
  return useCallback(
    (a: Alert) => {
      const c = a.campaignId ? app.campaigns.find((x) => x.id === a.campaignId) : undefined;
      if (c) {
        navigate('/campaigns');
        void app.openDetail(c);
      } else if (a.runId) {
        window.open(reportUrl(a.runId), '_blank', 'noopener');
      }
    },
    [app, navigate],
  );
}

const alertWorst = (list: Alert[]): 'critical' | 'warning' | 'info' =>
  list.some((a) => a.severity === 'critical')
    ? 'critical'
    : list.some((a) => a.severity === 'warning')
      ? 'warning'
      : 'info';

/** A single actionable notification row (clickable body + mark-read ×). */
function NotificationRow({
  a,
  read,
  onOpen,
  onRead,
}: {
  a: Alert;
  read: boolean;
  onOpen: (a: Alert) => void;
  onRead: (key: string) => void;
}) {
  return (
    <li className={`notif-item alert-${a.severity}${read ? ' is-read' : ''}`}>
      <button className="notif-item-main" onClick={() => onOpen(a)}>
        <span className="alert-dot" aria-hidden="true" />
        <span className="notif-item-body">
          <span className="notif-item-title">
            <span aria-hidden="true">{alertIcon(a.kind)}</span> {a.title}
          </span>
          <span className="notif-item-detail">{a.detail}</span>
          <span className="notif-item-meta">
            {a.target ? `${a.target} · ` : ''}
            {relTime(a.at)}
          </span>
        </span>
      </button>
      <button
        className="alert-x"
        aria-label="Mark as read"
        title="Mark as read"
        onClick={() => onRead(a.key)}
      >
        ×
      </button>
    </li>
  );
}

/**
 * Notifications bell — replaces the old always-on alerts banner. A discreet bell
 * in the sidebar with an unread badge; clicking opens a slide-over panel where
 * each alert (tarpit / low-WRS / regression / auto-killed …) is clickable
 * through to the campaign or run. Read-state is remembered per browser so the
 * badge only nags about what's new.
 */
export function NotificationsBell() {
  const app = useApp();
  const openAlert = useOpenAlert();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Set<string>>(loadReadKeys);
  const panelRef = useRef<HTMLDivElement>(null);

  const list = app.alerts ?? [];
  const unread = list.filter((a) => !read.has(a.key));
  const badge = unread.length;
  const worst = alertWorst(unread);

  // Close on Escape while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const markRead = (key: string) =>
    setRead((prev) => {
      const next = new Set(prev);
      next.add(key);
      saveReadKeys(next);
      return next;
    });
  const markAllRead = () => {
    const next = new Set(list.map((a) => a.key));
    setRead(next);
    saveReadKeys(next);
  };
  const onOpen = (a: Alert) => {
    markRead(a.key);
    setOpen(false);
    openAlert(a);
  };

  return (
    <div className="notif">
      <button
        type="button"
        className={`notif-bell${badge ? ' has-unread' : ''}`}
        aria-label={`Notifications${badge ? ` (${badge} unread)` : ''}`}
        aria-expanded={open}
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">🔔</span>
        {badge > 0 && (
          <span className={`notif-badge notif-${worst}`}>{badge > 9 ? '9+' : badge}</span>
        )}
      </button>
      {open && (
        <>
          <div className="notif-backdrop" onClick={() => setOpen(false)} />
          <div className="notif-panel" role="dialog" aria-label="Notifications" ref={panelRef}>
            <div className="notif-head">
              <b>Notifications</b>
              <div className="notif-head-actions">
                {badge > 0 && (
                  <button className="btn btn-sm btn-ghost" onClick={markAllRead}>
                    Mark all read
                  </button>
                )}
                <button
                  type="button"
                  className="notif-close"
                  aria-label="Close notifications"
                  onClick={() => setOpen(false)}
                >
                  ×
                </button>
              </div>
            </div>
            {list.length === 0 ? (
              <div className="notif-empty">
                <span aria-hidden="true">✓</span> All clear — nothing needs attention.
              </div>
            ) : (
              <ul className="notif-list">
                {list.map((a) => (
                  <NotificationRow
                    key={a.key}
                    a={a}
                    read={read.has(a.key)}
                    onOpen={onOpen}
                    onRead={markRead}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
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
            <NotificationsBell />
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
export function suiteWrs(
  members: Campaign[],
): { avg: number; min: number; level: WrsBreakdown['level']; scored: number } | null {
  const scored = members.filter((m) => m.wrs);
  if (!scored.length) return null;
  const vals = scored.map((m) => m.wrs!.wrs);
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  let worst = scored[0];
  for (const m of scored) if (m.wrs!.wrs < worst.wrs!.wrs) worst = m;
  return { avg, min: worst.wrs!.wrs, level: worst.wrs!.level, scored: scored.length };
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
function SuiteStepRow({ m, suiteName }: { m: Campaign; suiteName: string }) {
  const app = useApp();
  const spec = `${m.maxRps} rps · ${m.maxDurationSec}s${
    m.vector !== 'http-get' ? ` · ${m.vector.replace('http-', '')}` : ''
  }`;
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
        {m.status === 'RUNNING' && canDo(app.role, 'kill', app.authRequired) && (
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
  const canArchive = canDo(app.role, 'create', app.authRequired);
  const canRun = canDo(app.role, 'approve', app.authRequired);
  const t = useMemo(() => suiteTiming(g.members), [g.members]);
  const agg = useMemo(() => suiteWrs(g.members), [g.members]);
  const active = g.remaining > 0;
  const sequencing = g.running > 0; // a step is in flight → the live banner drives it
  const [open, setOpen] = useState(false);
  const allArchived = g.members.every((m) => m.archived);
  const busy = app.busy[g.suiteId];
  const scored = agg ? `${agg.scored}/${g.total} scored` : 'not scored';
  const [localBusy, setLocalBusy] = useState(false);

  const runScenario = async () => {
    setLocalBusy(true);
    try {
      await api.runSuite(g.suiteId);
      app.push('success', `Scenario approved — remaining steps will run in order.`);
      app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setLocalBusy(false);
    }
  };

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
          {canRun && active && !sequencing && (
            <button
              className="btn btn-sm btn-primary"
              disabled={localBusy}
              onClick={runScenario}
              title="One approval for the whole scenario: approves + runs every remaining step in order"
            >
              {localBusy ? <span className="spin" /> : null}▶ Approve &amp; run ({g.remaining})
            </button>
          )}
          {g.done > 0 && (
            <a
              className="btn btn-sm btn-ghost"
              href={suiteReportUrl(g.suiteId)}
              target="_blank"
              rel="noreferrer"
            >
              Assessment ↗
            </a>
          )}
          {canArchive && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={busy || active}
              onClick={() => app.archiveSuite(g.suiteId, g.suiteName, !allArchived)}
              title={
                active
                  ? 'Finish or cancel the sequence before archiving'
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
            <SuiteStepRow key={m.id} m={m} suiteName={g.suiteName} />
          ))}
        </div>
      ) : (
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
      )}
    </div>
  );
}

/** The "Launch" surface of the Campaigns workspace: the guided wizard (or the
 *  classic form when a preset is queued from the guide). */
export function CampaignLaunch() {
  const app = useApp();
  const canCreate = canDo(app.role, 'create', app.authRequired);
  const [showForm, setShowForm] = useState(false);
  // Open the form automatically when a preset is queued from the guide.
  useEffect(() => {
    if (app.draftPreset) setShowForm(true);
  }, [app.draftPreset]);

  if (!canCreate) {
    return (
      <p className="hint">
        Read-only access — browse the Templates and Plan tabs; an engineer creates and launches
        campaigns (a CISO approves them).
      </p>
    );
  }
  return (
    <>
      {!showForm && (
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            ＋ New campaign
          </button>
          <span className="hint">
            Guided: pick an objective and we recommend the template — or browse the Templates tab.
          </span>
        </div>
      )}
      {showForm &&
        (app.draftPreset ? (
          <NewCampaignForm onDone={() => setShowForm(false)} />
        ) : (
          <NewCampaignWizard onDone={() => setShowForm(false)} />
        ))}
    </>
  );
}

/** The persistent campaign list (suites grouped above standalone) with filters —
 *  always shown at the foot of the Campaigns workspace, under the active tab. */
export function CampaignList() {
  const app = useApp();
  // Pre-fill the search from ?q= so a "Protected zones" card deep-links straight
  // to that host's campaigns.
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState<StatusFilterId>('all');
  const [sort, setSort] = useState<SortId>('recent');
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
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'wrs')
      list = [...list].sort((a, b) => (b.wrs?.wrs ?? -1) - (a.wrs?.wrs ?? -1));
    return list;
  }, [app.campaigns, status, q, sort, showArchived]);

  // Suites (grouped) render above the standalone campaigns.
  const suiteGroups = useMemo(() => groupSuites(filtered), [filtered]);
  const standalone = useMemo(() => filtered.filter((c) => !c.suiteId), [filtered]);

  const hasCampaigns = app.campaigns.length > 0;

  return (
    <>
      <h2 className="section-title">
        Campaign list <span className="hint">({filtered.length})</span>
        {app.anyRunning && <span className="hint"> · auto-refreshing…</span>}
      </h2>

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
            <select value={sort} onChange={(e) => setSort(e.target.value as SortId)}>
              <option value="recent">Most recent</option>
              <option value="name">Name (A–Z)</option>
              <option value="wrs">WRS (high→low)</option>
            </select>
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
        {suiteGroups.map((g) => (
          <SuiteGroupCard key={g.suiteId} g={g} />
        ))}
        {standalone.map((c) => (
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
                  Assessment report ↗
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
      <h2 className="section-title" style={{ marginTop: 0 }}>
        Network layer <span className="hint">— from the lab (class C, L3/4)</span>
      </h2>
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
    const targetUrl = /^https?:\/\//.test(host) ? host : `https://${host}/`;
    setCreating(true);
    try {
      const name = `Plan — ${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
      const r =
        planPicks.length >= 2
          ? await api.composeSuite({ playbookIds: planPicks, name, target: targetUrl })
          : await api.instantiatePlaybook(planPicks[0], { target: targetUrl });
      app.push(
        'success',
        `Campaign created — ${r.campaigns.length} line${r.campaigns.length === 1 ? '' : 's'} from the plan (pending approval).`,
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
                  <b>Recommended campaign</b> — {planPicks.length} prioritised bounded line
                  {planPicks.length === 1 ? '' : 's'}, in ladder order, composed into one governed
                  campaign against <code>{target.trim()}</code>. It still goes through approval.
                </div>
                <button
                  className="btn btn-primary"
                  disabled={creating || !canDo(app.role, 'create', app.authRequired)}
                  onClick={createFromPlan}
                >
                  {creating
                    ? 'Creating…'
                    : `▶ Create campaign from this plan (${planPicks.length})`}
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

export function ReportsPage() {
  const app = useApp();
  const withRun = app.campaigns.filter((c) => c.runId);
  const [selected, setSelected] = useState<string | null>(null);
  const [selRun, setSelRun] = useState<CampaignRun | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const openResult = (c: Campaign) => {
    if (selected === c.id) {
      setSelected(null);
      setSelRun(null);
      return;
    }
    setSelected(c.id);
    setSelRun(null);
    setLoadingRun(true);
    api
      .getRun(c.runId!)
      .then((r) => {
        setSelRun(r);
        setLoadingRun(false);
      })
      .catch(() => setLoadingRun(false));
  };
  return (
    <>
      <PageHead
        title="Results"
        sub="Every measured run — its WRS, protection absorption and measurement confidence — plus assessment suites and aggregated DORA / NIS2 compliance."
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
      </div>

      <h2 className="section-title">Measured runs</h2>
      {withRun.length === 0 ? (
        <div className="empty">No campaign has run yet — no result available.</div>
      ) : (
        <div className="card" style={{ display: 'grid', gap: '.5rem' }}>
          {withRun.map((c) => (
            <Fragment key={c.id}>
              <div className="report-row">
                <span className="report-name">{c.name}</span>
                {c.wrs && <WrsPill wrs={c.wrs} />}
                <code className="report-target">{c.target}</code>
                <button
                  className={`btn btn-sm ${selected === c.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => openResult(c)}
                >
                  {selected === c.id ? 'Hide' : 'View'}
                </button>
                <a
                  className="btn btn-sm btn-ghost"
                  href={reportUrl(c.runId!)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Report ↗
                </a>
              </div>
              {selected === c.id && (
                <div
                  style={{
                    padding: '.4rem .2rem .8rem',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '.6rem',
                      marginBottom: '.5rem',
                    }}
                  >
                    {c.wrs && <WrsPill wrs={c.wrs} />}
                    {selRun && <ConfidenceBadge run={selRun} />}
                  </div>
                  {loadingRun && (
                    <span className="hint">
                      <span className="spin" /> Loading result…
                    </span>
                  )}
                  {selRun && <RunDetails run={selRun} />}
                </div>
              )}
            </Fragment>
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
        title="Assurance"
        sub="Tamper-evident audit log — every governed action (creation, approval, run, kill switch), hash-chained."
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
/** Officer-only destructive purge of test campaigns (kept out of everyday flow). */
function PurgeCard() {
  const app = useApp();
  const [scope, setScope] = useState<'settled' | 'all'>('settled');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const show = app.authRequired && canDo(app.role, 'manage', app.authRequired);
  if (!show) return null;

  const purge = async () => {
    setBusy(true);
    try {
      const r = await api.purgeCampaigns(scope);
      app.push(
        'success',
        `Purged ${r.deleted} campaign(s)` +
          `${r.killedRunning ? `, stopped ${r.killedRunning} running (re-purge once settled)` : ''}.`,
      );
      setConfirming(false);
      await app.refresh();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Purge campaigns</h2>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        Permanently delete test campaigns and their runs. This <b>cannot be undone</b>; the
        tamper-evident audit log is kept. Officer only, and audited.
      </p>
      <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={scope}
          aria-label="Purge scope"
          onChange={(e) => {
            setScope(e.target.value as 'settled' | 'all');
            setConfirming(false);
          }}
        >
          <option value="settled">Settled only (completed / killed)</option>
          <option value="all">Everything (stops running first)</option>
        </select>
        {confirming ? (
          <>
            <span className="hint" style={{ color: 'var(--danger)' }}>
              Delete {scope === 'all' ? 'ALL' : 'settled'} campaigns permanently?
            </span>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={purge}>
              {busy ? 'Purging…' : 'Confirm purge'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn btn-sm btn-danger" onClick={() => setConfirming(true)}>
            Purge…
          </button>
        )}
      </div>
    </div>
  );
}

function UsersCard() {
  const app = useApp();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [form, setForm] = useState({ email: '', role: 'viewer' as Role, password: '' });
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');
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
  const toggleStatus = async (u: ManagedUser) => {
    const next = (u.status ?? 'active') === 'disabled' ? 'active' : 'disabled';
    try {
      await api.setUserStatus(u.email, next);
      app.push('success', `${u.email} ${next === 'disabled' ? 'deactivated' : 'reactivated'}.`);
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };
  const submitReset = async (email: string) => {
    try {
      await api.resetUserPassword(email, resetPw);
      app.push(
        'success',
        `Temporary password set for ${email} — they must change it at next login.`,
      );
      setResetFor(null);
      setResetPw('');
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
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
          {users.map((u) => {
            const disabled = (u.status ?? 'active') === 'disabled';
            const editable = u.source === 'store' && u.email !== me;
            return (
              <div key={u.email} className="engine-row" style={{ flexWrap: 'wrap', gap: '.4rem' }}>
                <span className="engine-name" style={disabled ? { opacity: 0.55 } : undefined}>
                  {u.email}
                </span>
                {editable ? (
                  <select
                    className="role-select"
                    value={u.role}
                    onChange={(e) => changeRole(u.email, e.target.value as Role)}
                    title="Change role"
                    aria-label={`Role for ${u.email}`}
                  >
                    <option value="viewer">SOC / NOC (read only)</option>
                    <option value="engineer">Security Engineer (create + launch)</option>
                    <option value="ciso">CISO (approves)</option>
                    <option value="admin">Administrator (platform)</option>
                  </select>
                ) : (
                  <span className="engine-badge ok">{roleLabel[u.role]}</span>
                )}
                <span className={`engine-badge ${u.source === 'env' ? 'no' : 'ok'}`}>
                  {u.source}
                </span>
                {disabled && (
                  <span className="engine-badge no" title="Deactivated — cannot sign in">
                    disabled
                  </span>
                )}
                {u.mustChangePassword && (
                  <span
                    className="engine-badge"
                    title="Temporary password — change required at next login"
                  >
                    temp pw
                  </span>
                )}
                <span className="hint" style={{ marginLeft: 'auto' }}>
                  {u.lastLoginAt
                    ? `last login ${new Date(u.lastLoginAt).toLocaleString()}`
                    : u.source === 'store'
                      ? 'never signed in'
                      : ''}
                </span>
                {editable && (
                  <>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setResetFor(resetFor === u.email ? null : u.email);
                        setResetPw('');
                      }}
                    >
                      Reset password
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => toggleStatus(u)}>
                      {disabled ? 'Reactivate' : 'Deactivate'}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => remove(u.email)}>
                      Remove
                    </button>
                  </>
                )}
                {resetFor === u.email && (
                  <div
                    className="row"
                    style={{ flexBasis: '100%', gap: '.4rem', alignItems: 'center' }}
                  >
                    <input
                      type="password"
                      className="role-select"
                      style={{ flex: '1 1 12rem' }}
                      placeholder="New temporary password (min. 12 chars)"
                      value={resetPw}
                      autoComplete="new-password"
                      aria-label={`New password for ${u.email}`}
                      onChange={(e) => setResetPw(e.target.value)}
                    />
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={!resetPw}
                      onClick={() => submitReset(u.email)}
                    >
                      Set temporary password
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setResetFor(null);
                        setResetPw('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
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
            <option value="viewer">SOC / NOC (read only)</option>
            <option value="engineer">Security Engineer (create + launch)</option>
            <option value="ciso">CISO (approves)</option>
            <option value="admin">Administrator (platform)</option>
          </select>
        </div>
        <div className="field">
          <label>Temporary password</label>
          <input
            type="password"
            placeholder="min. 12 characters"
            value={form.password}
            autoComplete="new-password"
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </div>
        <div className="field" style={{ alignSelf: 'end' }}>
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Add user'}
          </button>
        </div>
      </form>
      <p className="hint" style={{ marginTop: '.5rem', marginBottom: 0 }}>
        The password you set is temporary — the new user must choose their own at first sign-in.
      </p>
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
      <h2>Operational limits (admin)</h2>
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
  // Testing notification delivery is platform administration (settings), so it's
  // gated on the admin's manage capability.
  const canTest = canDo(app.role, 'manage', app.authRequired);
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

/**
 * Observability card — point the app at a Grafana base URL (a local SSH tunnel
 * `http://localhost:3000`, or a reverse-proxied route). Once set, the Run
 * Theater and Results deep-link into the provisioned "ShieldTest — Runs"
 * dashboard. Stored per browser (localStorage); no server round-trip.
 */
function ObservabilityCard() {
  const app = useApp();
  const [url, setUrl] = useState(getGrafanaBase());
  const saved = getGrafanaBase();
  const dirty = url.trim().replace(/\/+$/, '') !== saved;
  const save = () => {
    setGrafanaBase(url);
    setUrl(getGrafanaBase());
    app.push('success', getGrafanaBase() ? 'Grafana URL saved.' : 'Grafana link cleared.');
  };
  return (
    <div className="card">
      <h2>Observability (Grafana)</h2>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        Prometheus scrapes the control plane; Grafana holds the historical, multi-run view. Point
        the app at your Grafana base URL and the Run Theater &amp; Results gain an{' '}
        <b>Open in Grafana ↗</b> deep-link, scoped to the run. Use a local tunnel (
        <code>ssh -L 3000:127.0.0.1:3000 …</code> → <code>http://localhost:3000</code>) or a
        reverse-proxied route.
      </p>
      <div className="field" style={{ maxWidth: 460 }}>
        <label htmlFor="grafana-url">Grafana base URL</label>
        <div style={{ display: 'flex', gap: '.4rem' }}>
          <input
            id="grafana-url"
            placeholder="http://localhost:3000"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={save}>
            Save
          </button>
        </div>
        <span className="hint">
          {saved ? (
            <>
              Linked to <code>{saved}</code>
            </>
          ) : (
            'Not linked — the Open in Grafana buttons stay hidden until set.'
          )}
        </span>
      </div>
      {saved && (
        <div className="page-actions" style={{ marginTop: '.75rem' }}>
          <a
            className="btn btn-sm btn-ghost"
            href={grafanaDashUrl(saved, 'run')}
            target="_blank"
            rel="noreferrer"
          >
            📊 Run &amp; Absorption ↗
          </a>
          <a
            className="btn btn-sm btn-ghost"
            href={grafanaDashUrl(saved, 'resilience')}
            target="_blank"
            rel="noreferrer"
          >
            📈 Resilience ↗
          </a>
          <a
            className="btn btn-sm btn-ghost"
            href={grafanaDashUrl(saved, 'platform')}
            target="_blank"
            rel="noreferrer"
          >
            🩺 Platform health ↗
          </a>
        </div>
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

      {app.authRequired && app.identity && (
        <div className="card" style={{ marginBottom: '1rem', maxWidth: 460 }}>
          <h2>Change my password</h2>
          <p className="hint" style={{ marginBottom: '.75rem' }}>
            Changing your password signs out your other sessions.
          </p>
          <ChangePasswordForm />
        </div>
      )}

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
      <PurgeCard />

      <NotificationsCard />

      <ObservabilityCard />

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
    icon: '✍️',
    body: 'In this workspace: the Launch wizard recommends a template for your objective, or browse Templates and compose lines, or build a Plan from recon. You attest you are authorized.',
  },
  {
    n: 2,
    title: 'Approve',
    icon: '✅',
    body: 'A Security Officer — not the author — signs off. Approval is valid for 24 hours.',
  },
  {
    n: 3,
    title: 'Execute',
    icon: '📡',
    body: 'Run now or on a schedule. The bounded HTTP generator and a legitimate probe run in parallel, under a 3-level kill switch.',
  },
  {
    n: 4,
    title: 'Score & report',
    icon: '🛡️',
    body: 'Get the WEDOS Resilience Score (WRS) and an HTML/PDF report; history and regressions tracked per target.',
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

export function GuidePage({ embedded = false }: { embedded?: boolean } = {}) {
  const app = useApp();
  const navigate = useNavigate();

  const use = (p: Preset) => {
    app.applyPreset(p);
    navigate('/campaigns?tab=launch');
  };

  return (
    <>
      {!embedded && (
        <PageHead
          title="How it works"
          sub="How a campaign works, from recon to report — plus ready-made configurations you can apply in one click."
        />
      )}

      <p className="guide-lead">
        A campaign is one bounded, governed test — from <b>recon</b> to <b>report</b>. Four steps,
        each safeguarded: an allowlist and hard caps up front, a second-person approval, a live kill
        switch, and a signed, tamper-evident record at the end.
      </p>

      <ol className="guide-flow">
        {STEPS.map((s) => (
          <li key={s.n} className="guide-step">
            <div className="guide-step-top">
              <span className="guide-step-n">{s.n}</span>
              <span className="guide-step-ico" aria-hidden="true">
                {s.icon}
              </span>
            </div>
            <div className="guide-step-title">{s.title}</div>
            <p className="guide-step-body">{s.body}</p>
          </li>
        ))}
      </ol>

      <h2 className="section-title">Reading the score (WRS)</h2>
      <div className="card">
        <p className="subtitle" style={{ marginBottom: '.75rem' }}>
          The <b>WEDOS Resilience Score</b> (0–100) blends detection, mitigation, availability and
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

      <h2 className="section-title">Engines &amp; safety</h2>
      <div className="guide-two">
        <div className="card">
          <h3 className="guide-card-title">Load engines</h3>
          <p className="subtitle" style={{ marginBottom: '.75rem' }}>
            Every campaign runs on a <b>load engine</b>. The built-in one needs nothing installed;
            the others delegate to team-operated tools (k6, Vegeta, Locust, JMeter, Gatling). All
            produce <b>bounded HTTP</b> load only — no volumetric or exhaustion vector.
            Not-installed engines are greyed out, and constant-only engines can't run ramp/wave
            profiles.
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
            Installed status is also in <b>Settings → Load engines</b>. Install an engine's binary
            on the server and it becomes selectable here.
          </p>
        </div>

        <div className="card">
          <h3 className="guide-card-title">Safety guardrails</h3>
          <ul className="guide-list">
            <li>
              Only allowlisted targets can be tested; everything else is rejected server-side.
            </li>
            <li>
              Hard caps on every run: ≤ 2000 rps, ≤ 500 concurrent, ≤ 900 s (15 min absolute
              timeout).
            </li>
            <li>
              The manual <b>kill switch</b> is always available during a run — use it if the target
              starts to struggle.
            </li>
            <li>Keep an eye on the probe (5xx rate, availability) while a campaign runs.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
