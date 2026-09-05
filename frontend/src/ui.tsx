import { useEffect, useRef, useState } from 'react';
import { reportUrl, streamUrl } from './api.js';
import type {
  Campaign,
  CampaignRun,
  CampaignStatus,
  RequestStep,
  WrsBreakdown,
  WrsPoint,
  LiveProgressData,
} from './api.js';
import { useApp, canDo } from './context.js';
import { PRESETS, estimatedRequests, formatCount } from './presets.js';
import type { Preset } from './presets.js';

const HARD_CAPS = { maxRps: 2000, concurrency: 500, maxDurationSec: 900 };

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

function wrsClass(level: WrsBreakdown['level']): string {
  return 'wrs-' + level.replace('+', 'p');
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
function RunDetails({ run }: { run: CampaignRun }) {
  return (
    <div className="details">
      <div className="metrics">
        <div className="metric">
          <div className="k">Requests</div>
          <div className="v">{run.generator.totalRequests}</div>
        </div>
        <div className="metric">
          <div className="k">Success / failures</div>
          <div className="v">
            {run.generator.successful} / {run.generator.failed}
          </div>
        </div>
        <div className="metric">
          <div className="k">Actual RPS</div>
          <div className="v">{run.generator.actualRps}</div>
        </div>
        <div className="metric">
          <div className="k">Latency p95</div>
          <div className="v">{run.generator.latencyMs.p95} ms</div>
        </div>
        <div className="metric">
          <div className="k">Probe 5xx</div>
          <div className="v">{run.probe.errorRate5xx}%</div>
        </div>
        <div className="metric">
          <div className="k">Probe availability</div>
          <div className="v">
            {run.probe.available}/{run.probe.samples}
          </div>
        </div>
      </div>
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
      {run.wrs.estimated && (
        <p className="hint" style={{ marginTop: '.5rem' }}>
          Detection and Mitigation are <b>estimated</b> (no protection integration): they are
          constant, so the WRS mostly reflects measured availability.
        </p>
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

const emptyForm = {
  name: '',
  target: 'http://127.0.0.1:8080/health',
  probeUrl: 'http://127.0.0.1:8080/health',
  vector: 'http-get',
  maxRps: 20,
  concurrency: 5,
  maxDurationSec: 30,
  scheduledAt: '',
  recurrenceMin: '',
  profile: 'constant',
  agent: '',
  body: '',
  flow: '',
  flowAdvanced: false,
};

/** Parses the advanced flow editor (raw JSON RequestStep[]). Throws on error. */
function parseFlowJson(raw: string): RequestStep[] | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const parsed = JSON.parse(t);
  if (!Array.isArray(parsed)) throw new Error('Flow (JSON) must be an array of steps.');
  return parsed as RequestStep[];
}

/**
 * Parses a flow editor (one step per line: "METHOD /path [thinkMs]") into
 * bounded RequestStep[]. Each step keeps the target's host, so it stays within
 * the allowlist. Returns undefined when empty.
 */
function parseFlow(raw: string, origin: string): RequestStep[] | undefined {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines.map((line) => {
    const [m, p, t] = line.split(/\s+/);
    const method = (m || 'GET').toUpperCase();
    let url = origin;
    try {
      url = new URL(p || '/', origin).href;
    } catch {
      /* keep origin */
    }
    const thinkMs = t ? Number(t) : undefined;
    return { method, url, thinkMs: Number.isFinite(thinkMs) ? thinkMs : undefined };
  });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
function formatInterval(min: number): string {
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}
function buildScenario(profile: string, maxRps: number, durationSec: number) {
  const third = Math.max(1, Math.round(durationSec / 3));
  const pct = (p: number) => Math.max(1, Math.round((maxRps * p) / 100));
  if (profile === 'ramp')
    return [
      { maxRps: pct(25), durationSec: third },
      { maxRps: pct(50), durationSec: third },
      { maxRps: pct(100), durationSec: third },
    ];
  if (profile === 'wave')
    return [
      { maxRps: pct(100), durationSec: third },
      { maxRps: pct(20), durationSec: third },
      { maxRps: pct(100), durationSec: third },
    ];
  return undefined;
}

export function NewCampaignForm({ onDone }: { onDone?: () => void }) {
  const app = useApp();
  const [form, setForm] = useState({ ...emptyForm });
  const [attested, setAttested] = useState(false);
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);

  // Apply a preset's load shape (rate/concurrency/duration/profile) and its
  // recommended engine when installed — never the target — keeping whatever the
  // operator already typed for name/target/probe.
  const applyPreset = (p: Preset) => {
    const recAvailable = app.agents.some((a) => a.id === p.recommendedAgent && a.available);
    setForm((f) => ({
      ...f,
      name: f.name.trim() || p.name,
      maxRps: p.maxRps,
      concurrency: p.concurrency,
      maxDurationSec: p.maxDurationSec,
      profile: p.profile,
      agent: recAvailable ? p.recommendedAgent : f.agent,
    }));
    setAppliedPreset(p.id);
  };

  // Swap the host of a URL, preserving protocol/port/path (falls back to a
  // bare http URL if the current value can't be parsed).
  const withHost = (current: string, host: string): string => {
    try {
      const u = new URL(current);
      u.hostname = host;
      return u.toString();
    } catch {
      return `http://${host}/`;
    }
  };

  // Consume a preset queued from another page (e.g. the Guide).
  const { draftPreset, clearDraftPreset } = app;
  useEffect(() => {
    if (draftPreset) {
      applyPreset(draftPreset);
      clearDraftPreset();
    }
  }, [draftPreset]);

  // Selected load engine (empty = server default) and its multi-phase support.
  const selectedAgent = app.agents.find((a) => a.id === form.agent);
  const multiPhaseOk = !selectedAgent || selectedAgent.multiPhase;
  // Flow editor only when the selected engine (or the default builtin) can run
  // multi-step flows.
  const flowSupported = selectedAgent ? selectedAgent.flowCapable : true;
  const targetOrigin = (() => {
    try {
      return new URL(form.target).origin;
    } catch {
      return '';
    }
  })();
  // Switching to a constant-only engine resets a ramp/wave profile.
  const setAgent = (id: string) => {
    const a = app.agents.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      agent: id,
      profile: a && !a.multiPhase && f.profile !== 'constant' ? 'constant' : f.profile,
    }));
    setAppliedPreset(null);
  };

  const targetAllowed = (() => {
    const h = hostOf(form.target);
    return h !== null && app.allowed.includes(h);
  })();
  const probeAllowed = (() => {
    const h = hostOf(form.probeUrl);
    return h !== null && app.allowed.includes(h);
  })();
  const capsOk =
    form.maxRps > 0 &&
    form.maxRps <= HARD_CAPS.maxRps &&
    form.concurrency >= 1 &&
    form.concurrency <= HARD_CAPS.concurrency &&
    form.maxDurationSec >= 1 &&
    form.maxDurationSec <= HARD_CAPS.maxDurationSec;
  const identityOk = app.authRequired ? app.identity !== null : app.operator.trim() !== '';
  const canCreate = canDo(app.role, 'create', app.authRequired);
  const formValid =
    form.name.trim() !== '' &&
    identityOk &&
    targetAllowed &&
    probeAllowed &&
    capsOk &&
    attested &&
    canCreate;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formValid) return;
    try {
      await app.createCampaign({
        name: form.name,
        target: form.target,
        probeUrl: form.probeUrl,
        vector: form.vector,
        body: form.vector === 'http-post' ? form.body : undefined,
        maxRps: Number(form.maxRps),
        concurrency: Number(form.concurrency),
        maxDurationSec: Number(form.maxDurationSec),
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
        scenario: buildScenario(form.profile, Number(form.maxRps), Number(form.maxDurationSec)),
        agent: form.agent || undefined,
        recurrence: form.recurrenceMin ? { intervalMin: Number(form.recurrenceMin) } : undefined,
        flow:
          flowSupported && form.flow.trim()
            ? form.flowAdvanced
              ? parseFlowJson(form.flow)
              : parseFlow(form.flow, targetOrigin)
            : undefined,
        authorized: true,
      });
      setForm({ ...emptyForm });
      setAttested(false);
      onDone?.();
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };

  if (!canCreate) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>New campaign</h2>
        {onDone && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
      <div className="presets-row">
        <span className="presets-label">Start from a preset:</span>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`chip${appliedPreset === p.id ? ' chip-active' : ''}`}
            title={p.when}
            onClick={() => applyPreset(p)}
          >
            <span aria-hidden="true">{p.icon}</span> {p.name}
          </button>
        ))}
      </div>
      <form className="grid" onSubmit={submit}>
        <div className="field">
          <label>Name</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div className="field">
          <label>Vector</label>
          <select
            value={form.vector}
            onChange={(e) => setForm({ ...form, vector: e.target.value })}
          >
            <option value="http-get">http-get</option>
            <option value="http-post">http-post</option>
          </select>
        </div>
        <div className="field">
          <label>Target (URL)</label>
          <input
            className={form.target && !targetAllowed ? 'invalid' : ''}
            value={form.target}
            onChange={(e) => setForm({ ...form, target: e.target.value })}
          />
          {app.allowed.length > 0 && (
            <div className="allowed-chips">
              <span className="hint">Allowed hosts:</span>
              {app.allowed.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="chip chip-xs"
                  title={`Use ${h} (keeps port/path)`}
                  onClick={() => setForm((f) => ({ ...f, target: withHost(f.target, h) }))}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
          {form.target && !targetAllowed && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              Host not in allowlist — will be rejected.
            </span>
          )}
        </div>
        <div className="field">
          <label>Probe (URL)</label>
          <input
            className={form.probeUrl && !probeAllowed ? 'invalid' : ''}
            value={form.probeUrl}
            onChange={(e) => setForm({ ...form, probeUrl: e.target.value })}
          />
          {app.allowed.length > 0 && (
            <div className="allowed-chips">
              <span className="hint">Allowed hosts:</span>
              {app.allowed.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="chip chip-xs"
                  title={`Use ${h} (keeps port/path)`}
                  onClick={() => setForm((f) => ({ ...f, probeUrl: withHost(f.probeUrl, h) }))}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
          {form.probeUrl && !probeAllowed && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              Host not in allowlist — will be rejected.
            </span>
          )}
        </div>
        <div className="field">
          <label>Max RPS</label>
          <input
            type="number"
            value={form.maxRps}
            onChange={(e) => {
              setForm({ ...form, maxRps: Number(e.target.value) });
              setAppliedPreset(null);
            }}
          />
          <span className="hint">cap {HARD_CAPS.maxRps}</span>
        </div>
        <div className="field">
          <label>Concurrency</label>
          <input
            type="number"
            value={form.concurrency}
            onChange={(e) => {
              setForm({ ...form, concurrency: Number(e.target.value) });
              setAppliedPreset(null);
            }}
          />
          <span className="hint">1–{HARD_CAPS.concurrency}</span>
        </div>
        <div className="field">
          <label>Max duration (s)</label>
          <input
            type="number"
            value={form.maxDurationSec}
            onChange={(e) => {
              setForm({ ...form, maxDurationSec: Number(e.target.value) });
              setAppliedPreset(null);
            }}
          />
          <span className="hint">≤ {HARD_CAPS.maxDurationSec}s (15 min)</span>
        </div>
        <div className="field">
          <label>Load profile</label>
          <select
            value={form.profile}
            onChange={(e) => {
              setForm({ ...form, profile: e.target.value });
              setAppliedPreset(null);
            }}
          >
            <option value="constant">Constant</option>
            <option value="ramp" disabled={!multiPhaseOk}>
              Ramp-up (25→50→100%)
            </option>
            <option value="wave" disabled={!multiPhaseOk}>
              Waves (100→20→100%)
            </option>
          </select>
          {!multiPhaseOk && (
            <span className="hint">{selectedAgent?.name} runs a constant rate only.</span>
          )}
        </div>
        <div className="field">
          <label>Load engine</label>
          <select value={form.agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Server default ({app.agentName || 'builtin-http'})</option>
            {app.agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.available}>
                {a.name}
                {a.available ? '' : ' — not installed'}
                {a.multiPhase ? '' : ' (constant only)'}
              </option>
            ))}
          </select>
          {selectedAgent && <span className="hint">{selectedAgent.description}</span>}
        </div>
        <div className="field">
          <label>Schedule (optional)</label>
          <input
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
          />
          <span className="hint">auto-run once approved</span>
        </div>
        <div className="field">
          <label>Repeat every (optional)</label>
          <select
            value={form.recurrenceMin}
            onChange={(e) => setForm({ ...form, recurrenceMin: e.target.value })}
          >
            <option value="">No repeat (single run)</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="180">3 hours</option>
            <option value="360">6 hours</option>
            <option value="720">12 hours</option>
          </select>
          <span className="hint">re-runs within the 24 h approval window</span>
        </div>
        {form.vector === 'http-post' && (
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Request body (POST)</label>
            <textarea
              rows={3}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </div>
        )}
        {flowSupported ? (
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>
              Request flow — L7 journey (optional)
              <label className="hint" style={{ marginLeft: '.75rem', fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={form.flowAdvanced}
                  onChange={(e) => setForm({ ...form, flowAdvanced: e.target.checked })}
                />{' '}
                Advanced (JSON: headers + correlation)
              </label>
            </label>
            <textarea
              rows={form.flowAdvanced ? 8 : 4}
              placeholder={
                form.flowAdvanced
                  ? `[\n  {"method":"POST","url":"${targetOrigin || 'http://host'}/login","extract":{"name":"token","from":"json","expr":"token"}},\n  {"method":"GET","url":"${targetOrigin || 'http://host'}/me","headers":{"Authorization":"Bearer {{token}}"}}\n]`
                  : 'GET /\nPOST /login 500\nGET /dashboard\nGET /logout'
              }
              value={form.flow}
              onChange={(e) => setForm({ ...form, flow: e.target.value })}
              style={{ fontFamily: 'var(--mono, monospace)' }}
            />
            <span className="hint">
              {form.flowAdvanced ? (
                <>
                  JSON array of steps (<code>method, url, body?, headers?, thinkMs?, extract?</code>
                  ). Correlation: <code>extract</code> a value (json/header/regex) and reuse it as{' '}
                  <code>{'{{name}}'}</code> in later steps — needs the built-in engine.
                </>
              ) : (
                <>
                  One step per line: <code>METHOD /path [thinkMs]</code>. Each step hits the target
                  host (allowlisted); the rate cap still bounds total req/s.
                </>
              )}
            </span>
          </div>
        ) : (
          form.agent && (
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="hint">
                Engine <b>{selectedAgent?.name}</b> doesn&apos;t support multi-step flows — choose
                builtin/k6/jmeter/gatling/locust to define an L7 journey.
              </span>
            </div>
          )
        )}
        <label className="attest">
          <input
            type="checkbox"
            checked={attested}
            onChange={(e) => setAttested(e.target.checked)}
          />
          <span>
            I attest that I own the target or hold a <b>written authorization</b> to test it
            (internal WEDOS / authorized scope).
          </span>
        </label>
        {capsOk && (
          <p className="estimate">
            ≈{' '}
            <b>{formatCount(estimatedRequests(form.maxRps, form.maxDurationSec, form.profile))}</b>{' '}
            requests over {form.maxDurationSec}s, peak {form.maxRps} rps · {form.concurrency}{' '}
            concurrent. Bounded HTTP — kill switch stays available.
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={!formValid}>
          Submit for approval
        </button>
      </form>
    </section>
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
