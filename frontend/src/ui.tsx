import { useEffect, useState } from 'react';
import { reportUrl, streamUrl } from './api.js';
import type {
  Campaign,
  CampaignRun,
  CampaignStatus,
  WrsBreakdown,
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

export function Sparkline({
  points,
  regression,
}: {
  points: { wrs: number }[];
  regression: boolean;
}) {
  const w = 180;
  const h = 40;
  const pad = 5;
  if (points.length === 0) return null;
  const xs =
    points.length > 1
      ? points.map((_, i) => pad + (i * (w - 2 * pad)) / (points.length - 1))
      : [w / 2];
  const ys = points.map((p) => h - pad - (p.wrs / 100) * (h - 2 * pad));
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const color = regression ? 'var(--danger)' : 'var(--brand)';
  const ty = h - pad - (70 / 100) * (h - 2 * pad);
  return (
    <svg width={w} height={h} className="spark" aria-hidden="true">
      <line x1={pad} y1={ty} x2={w - pad} y2={ty} className="spark-thresh" />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="3" fill={color} />
    </svg>
  );
}

function LiveProgress({ campaignId }: { campaignId: string }) {
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
        <span className="hint">Starting run…</span>
      </div>
    );
  const pct = Math.min(100, Math.round((p.elapsedSec / Math.max(p.maxDurationSec, 1)) * 100));
  return (
    <div className="details">
      <div className="live-bar">
        <div className="live-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="live-stats">
        <span>
          ⏱ {p.elapsedSec}s / {p.maxDurationSec}s
        </span>
        <span>{p.sent} requests</span>
        <span>{p.actualRps} rps</span>
        <span>
          {p.successful} ok · {p.failed} failed
        </span>
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
      </div>

      {c.status === 'RUNNING' && <LiveProgress campaignId={c.id} />}
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
              <dt>Scheduled</dt>
              <dd>{new Date(c.scheduledAt).toLocaleString()}</dd>
            </div>
          )}
        </dl>

        {c.status === 'RUNNING' && <LiveProgress campaignId={c.id} />}
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
  profile: 'constant',
  body: '',
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
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

export function NewCampaignForm() {
  const app = useApp();
  const [form, setForm] = useState({ ...emptyForm });
  const [attested, setAttested] = useState(false);
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);

  // Apply a preset's load shape (rate/concurrency/duration/profile) — never the
  // target — keeping whatever the operator already typed for name/target/probe.
  const applyPreset = (p: Preset) => {
    setForm((f) => ({
      ...f,
      name: f.name.trim() || p.name,
      maxRps: p.maxRps,
      concurrency: p.concurrency,
      maxDurationSec: p.maxDurationSec,
      profile: p.profile,
    }));
    setAppliedPreset(p.id);
  };

  // Consume a preset queued from another page (e.g. the Guide).
  const { draftPreset, clearDraftPreset } = app;
  useEffect(() => {
    if (draftPreset) {
      applyPreset(draftPreset);
      clearDraftPreset();
    }
  }, [draftPreset]);

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
        authorized: true,
      });
      setForm({ ...emptyForm });
      setAttested(false);
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };

  if (!canCreate) return null;
  return (
    <section className="card">
      <h2>New campaign</h2>
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
            <option value="ramp">Ramp-up (25→50→100%)</option>
            <option value="wave">Waves (100→20→100%)</option>
          </select>
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
