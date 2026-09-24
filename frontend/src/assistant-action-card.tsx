import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  type Campaign,
  type CampaignRun,
  type CampaignStatus,
  type ProtectedTarget,
} from './api.js';
import { useApp, canDo } from './context.js';
import type { AssistantAction, ActionRow } from './assistant-action.js';

/**
 * assistant-action-card.tsx — inline, governed execution of the actions the
 * assistant (Qwen) prepares. Everything happens INSIDE the Assistant screen:
 * a target is registered and authorized, a campaign is submitted, approved,
 * co-signed when dual-control is on, launched, and its result shown — without
 * ever leaving the page.
 *
 * Governance is unchanged and server-enforced: RBAC gates every button, the
 * approver must differ from the author (and the CISO co-signer from both),
 * HARD_CAPS clamp the bounds, and the kill switch stays live while a campaign
 * runs. The client only mirrors those rules to hide controls a role can't use.
 */

const TAG: Record<AssistantAction['kind'], string> = {
  campaign: 'Proposed test',
  target: 'Register target',
  limits: 'Adjust limits',
  navigate: 'Go to',
};

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Request failed.';
}
function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}
function clampInt(v: unknown, dflt: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  const i = Number.isFinite(n) ? Math.round(n) : dflt;
  return Math.max(1, Math.min(i, max));
}

function RowsGrid({ rows }: { rows: ActionRow[] }) {
  if (!rows.length) return null;
  return (
    <dl className="assistant-proposal-grid">
      {rows.map((r) => (
        <div key={r.label}>
          <dt>{r.label}</dt>
          <dd
            className={[r.mono ? 'mono' : '', r.over ? 'over' : ''].join(' ').trim() || undefined}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------------------------------------- campaign */

type CampaignActionT = Extract<AssistantAction, { kind: 'campaign' }>;

function CampaignCard({ action }: { action: CampaignActionT }) {
  const app = useApp();
  const navigate = useNavigate();
  const caps = app.hardCaps;
  const canCreate = canDo(app.role, 'create', app.authRequired);
  const canApprove = canDo(app.role, 'approve', app.authRequired);
  const canCiso = canDo(app.role, 'cisoApprove', app.authRequired);
  const canExecute = canDo(app.role, 'execute', app.authRequired);
  const canKill = canDo(app.role, 'kill', app.authRequired);

  const seed = action.seed;
  const seedTarget = typeof seed.target === 'string' ? seed.target : '';
  const seedProbe = (() => {
    const p = typeof seed.probeUrl === 'string' ? seed.probeUrl : '';
    const ph = p ? hostOf(p) : null;
    if (ph && app.allowed.includes(ph)) return p;
    const th = hostOf(seedTarget);
    if (th && app.allowed.includes(th)) {
      try {
        return new URL(seedTarget).origin + '/health';
      } catch {
        /* fall through */
      }
    }
    return p;
  })();

  const [form, setForm] = useState({
    name:
      (typeof seed.name === 'string' && seed.name.trim()) ||
      action.title ||
      'Bounded resilience test',
    target: seedTarget,
    probeUrl: seedProbe,
    vector: (seed.vector === 'http-post' ? 'http-post' : 'http-get') as 'http-get' | 'http-post',
    maxRps: clampInt(seed.maxRps, 10, caps.maxRps),
    concurrency: clampInt(seed.concurrency, 5, caps.maxConcurrency),
    maxDurationSec: clampInt(seed.maxDurationSec, 60, caps.maxDurationSec),
  });
  const [attested, setAttested] = useState(false);
  const [camp, setCamp] = useState<Campaign | null>(null);
  const [run, setRun] = useState<CampaignRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const targetHost = hostOf(form.target);
  const probeHost = hostOf(form.probeUrl);
  const targetAllowed = !!targetHost && app.allowed.includes(targetHost);
  const probeAllowed = !!probeHost && app.allowed.includes(probeHost);
  const capsOk =
    form.maxRps > 0 &&
    form.maxRps <= caps.maxRps &&
    form.concurrency >= 1 &&
    form.concurrency <= caps.maxConcurrency &&
    form.maxDurationSec >= 1 &&
    form.maxDurationSec <= caps.maxDurationSec;
  const identityOk = app.authRequired ? app.identity !== null : app.operator.trim() !== '';
  const canSubmit =
    canCreate &&
    form.name.trim() !== '' &&
    targetAllowed &&
    probeAllowed &&
    capsOk &&
    attested &&
    identityOk;

  const status: CampaignStatus | null = camp?.status ?? null;
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    if (!canSubmit || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const c = await api.createCampaign({
        name: form.name.trim(),
        target: form.target.trim(),
        probeUrl: form.probeUrl.trim(),
        vector: form.vector,
        maxRps: form.maxRps,
        concurrency: form.concurrency,
        maxDurationSec: form.maxDurationSec,
        authorized: true,
        createdBy: app.authRequired ? app.identity?.email : app.operator,
      });
      setCamp(c);
      app.push('success', 'Campaign created — awaiting approval.');
      app.refresh();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'APPROVED' | 'REJECTED') {
    if (!camp || busy) return;
    if (decision === 'REJECTED' && !reason.trim()) {
      setErr('A reason is required to reject.');
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const c = await api.approve(camp.id, {
        approvedBy: app.authRequired ? app.identity?.email : app.operator,
        decision,
        reason: reason.trim() || undefined,
      });
      setCamp(c);
      app.push('success', decision === 'APPROVED' ? 'Campaign approved.' : 'Campaign rejected.');
      app.refresh();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function cosign() {
    if (!camp || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const c = await api.cisoApprove(camp.id);
      setCamp(c);
      app.push('success', 'CISO sign-off recorded.');
      app.refresh();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    if (!camp || busy) return;
    setErr(null);
    setBusy(true);
    setCamp({ ...camp, status: 'RUNNING' });
    try {
      const r = await api.execute(camp.id);
      setRun(r);
      setCamp((c) => (c ? { ...c, status: r.status } : c));
      app.push(
        r.status === 'COMPLETED' ? 'success' : 'info',
        `Run ${r.status} — WRS ${r.wrs.wrs} (${r.wrs.level}).`,
      );
      app.refresh();
      app.loadHistory();
    } catch (e) {
      setErr(msg(e));
      try {
        const list = await api.listCampaigns();
        const cc = list.find((x) => x.id === camp.id);
        if (cc) setCamp(cc);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  async function killNow() {
    if (!camp) return;
    try {
      await api.kill(camp.id);
      app.push('info', 'Kill switch triggered.');
    } catch (e) {
      setErr(msg(e));
    }
  }

  const num = (label: string, key: 'maxRps' | 'concurrency' | 'maxDurationSec', max: number) => (
    <label className="assistant-field">
      <span>
        {label} <span className="hint">≤ {max}</span>
      </span>
      <input
        type="number"
        min={1}
        max={max}
        value={form[key]}
        onChange={(e) =>
          set({ [key]: clampInt(e.target.value, form[key], max) } as Partial<typeof form>)
        }
      />
    </label>
  );

  return (
    <div className="assistant-proposal assistant-proposal-campaign">
      <div className="assistant-proposal-head">
        <span className="assistant-proposal-tag">{TAG.campaign}</span>
        <strong>{form.name || action.title}</strong>
        {status && (
          <span className={`assistant-status assistant-status-${status.toLowerCase()}`}>
            {status.replace('_', ' ')}
          </span>
        )}
      </div>

      {action.rationale && !camp && <p className="assistant-proposal-why">{action.rationale}</p>}

      {!camp && (
        <>
          <div className="assistant-form">
            <label className="assistant-field assistant-field-wide">
              <span>Name</span>
              <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="assistant-field assistant-field-wide">
              <span>Target URL</span>
              <input
                className={form.target && !targetAllowed ? 'invalid' : ''}
                value={form.target}
                onChange={(e) => set({ target: e.target.value })}
              />
              {form.target && !targetAllowed && (
                <span className="hint assistant-error">
                  Host not in allowlist — will be rejected.
                </span>
              )}
            </label>
            <label className="assistant-field assistant-field-wide">
              <span>Probe URL</span>
              <input
                className={form.probeUrl && !probeAllowed ? 'invalid' : ''}
                value={form.probeUrl}
                onChange={(e) => set({ probeUrl: e.target.value })}
              />
              {form.probeUrl && !probeAllowed && (
                <span className="hint assistant-error">
                  Host not in allowlist — will be rejected.
                </span>
              )}
            </label>
            <label className="assistant-field">
              <span>Vector</span>
              <select
                value={form.vector}
                onChange={(e) =>
                  set({
                    vector: e.target.value === 'http-post' ? 'http-post' : 'http-get',
                  })
                }
              >
                <option value="http-get">http-get</option>
                <option value="http-post">http-post</option>
              </select>
            </label>
            {num('Max RPS', 'maxRps', caps.maxRps)}
            {num('Concurrency', 'concurrency', caps.maxConcurrency)}
            {num('Duration (s)', 'maxDurationSec', caps.maxDurationSec)}
          </div>

          <label className="assistant-attest">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            <span>
              I attest I own this target or hold written authorization to test it (internal /
              authorized scope).
            </span>
          </label>

          <div className="assistant-proposal-actions">
            {canCreate ? (
              <button
                className="btn btn-primary"
                disabled={!canSubmit || busy}
                onClick={() => void submit()}
              >
                {busy ? 'Submitting…' : 'Submit for approval'}
              </button>
            ) : (
              <span className="hint">
                An engineer configures and launches this; a CISO approves it.
              </span>
            )}
          </div>
          <p className="assistant-proposal-note">
            Nothing runs on submit — it creates a governed campaign (approval · HARD_CAPS ·
            kill-switch).
          </p>
        </>
      )}

      {camp && (
        <>
          <RowsGrid
            rows={[
              { label: 'Target', value: form.target, mono: true },
              { label: 'Vector', value: form.vector },
              { label: 'Max RPS', value: String(form.maxRps) },
              { label: 'Concurrency', value: String(form.concurrency) },
              { label: 'Duration', value: `${form.maxDurationSec}s` },
            ]}
          />

          {status === 'PENDING_APPROVAL' && (
            <div className="assistant-stage">
              {canApprove ? (
                <>
                  <input
                    className="assistant-reason"
                    placeholder="Reason (required to reject)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <div className="assistant-proposal-actions">
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void decide('APPROVED')}
                    >
                      Approve
                    </button>
                    <button className="btn" disabled={busy} onClick={() => void decide('REJECTED')}>
                      Reject
                    </button>
                  </div>
                  <p className="hint">
                    Separation of duties: the approver must differ from the author.
                  </p>
                </>
              ) : (
                <p className="hint">Awaiting CISO approval.</p>
              )}
            </div>
          )}

          {status === 'APPROVED' && (
            <div className="assistant-stage">
              {app.requireCisoApproval && !camp.cisoApprovedBy ? (
                canCiso ? (
                  <div className="assistant-proposal-actions">
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void cosign()}
                    >
                      CISO sign-off (dual control)
                    </button>
                  </div>
                ) : (
                  <p className="hint">Approved — awaiting a second CISO sign-off (dual control).</p>
                )
              ) : canExecute ? (
                <div className="assistant-proposal-actions">
                  <button className="btn btn-primary" disabled={busy} onClick={() => void runNow()}>
                    {busy ? 'Launching…' : 'Run now'}
                  </button>
                </div>
              ) : (
                <p className="hint">Approved — an engineer launches it.</p>
              )}
            </div>
          )}

          {status === 'RUNNING' && (
            <div className="assistant-stage">
              <p className="hint">Running against {targetHost}…</p>
              {canKill && (
                <div className="assistant-proposal-actions">
                  <button className="btn btn-danger" onClick={() => void killNow()}>
                    Kill switch
                  </button>
                </div>
              )}
            </div>
          )}

          {run && (
            <div className="assistant-stage assistant-result">
              <RowsGrid
                rows={[
                  { label: 'Status', value: run.status.replace('_', ' ') },
                  { label: 'WRS', value: `${run.wrs.wrs} (${run.wrs.level})` },
                ]}
              />
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('/theater')}>
                Open Run Theater →
              </button>
            </div>
          )}

          {status === 'REJECTED' && <p className="hint assistant-error">Rejected.</p>}
        </>
      )}

      {err && <p className="hint assistant-error">⚠ {err}</p>}
    </div>
  );
}

/* ----------------------------------------------------------------- target */

type TargetActionT = Extract<AssistantAction, { kind: 'target' }>;

function TargetCard({ action }: { action: TargetActionT }) {
  const app = useApp();
  const canManageTargets = canDo(app.role, 'targetManage', app.authRequired);
  const canAuthorize = canDo(app.role, 'targetAuthorize', app.authRequired);
  const rawHost = action.draft.host ?? '';
  const host = rawHost.toLowerCase();
  const already = app.allowed.includes(host);

  const [tgt, setTgt] = useState<ProtectedTarget | null>(null);
  const [att, setAtt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function register() {
    if (busy || !rawHost) return;
    setErr(null);
    setBusy(true);
    try {
      const t = await api.registerTarget({
        host: rawHost,
        displayName: action.draft.displayName,
        owner: action.draft.owner,
        notes: action.draft.notes,
        attestation: att.trim() || undefined,
      });
      setTgt(t);
      app.push('success', 'Target registered.');
      app.refresh();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function authorize() {
    if (!tgt || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const t = await api.authorizeTarget(tgt.id);
      setTgt(t);
      app.push('success', 'Target authorized.');
      app.refresh();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="assistant-proposal assistant-proposal-target">
      <div className="assistant-proposal-head">
        <span className="assistant-proposal-tag">{TAG.target}</span>
        <strong>{action.title}</strong>
      </div>
      <RowsGrid rows={action.rows} />
      {action.rationale && <p className="assistant-proposal-why">{action.rationale}</p>}

      {already ? (
        <p className="hint assistant-ok">
          ✓ Already an authorized target — you can target it directly.
        </p>
      ) : !tgt ? (
        <>
          <label className="assistant-field assistant-field-wide">
            <span>Attestation (optional — authorizes in the same step)</span>
            <input
              placeholder="Written authorization reference / note"
              value={att}
              onChange={(e) => setAtt(e.target.value)}
            />
          </label>
          <div className="assistant-proposal-actions">
            {canManageTargets ? (
              <button className="btn btn-primary" disabled={busy} onClick={() => void register()}>
                {busy ? 'Registering…' : 'Register target'}
              </button>
            ) : (
              <span className="hint">Target onboarding is limited to operators.</span>
            )}
          </div>
        </>
      ) : tgt.authStatus === 'authorized' ? (
        <p className="hint assistant-ok">
          ✓ Registered and authorized by {tgt.authorizedBy ?? 'CISO'}.
        </p>
      ) : (
        <div className="assistant-stage">
          <p className="hint">Registered · status {tgt.authStatus}.</p>
          {canAuthorize ? (
            <div className="assistant-proposal-actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void authorize()}>
                Authorize (CISO)
              </button>
            </div>
          ) : (
            <p className="hint">Awaiting CISO authorization.</p>
          )}
        </div>
      )}
      {err && <p className="hint assistant-error">⚠ {err}</p>}
    </div>
  );
}

/* ----------------------------------------------------------------- limits */

type LimitsActionT = Extract<AssistantAction, { kind: 'limits' }>;

function LimitsCard({ action }: { action: LimitsActionT }) {
  const app = useApp();
  const canSetLimits = canDo(app.role, 'limits', app.authRequired);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const over = action.over.length > 0;

  async function apply() {
    if (busy || over) return;
    setErr(null);
    setBusy(true);
    try {
      await api.setLimits({
        maxRps: action.caps.maxRps,
        maxConcurrency: action.caps.maxConcurrency,
        maxDurationSec: action.caps.maxDurationSec,
      });
      app.applyEffectiveCaps(action.caps);
      setDone(true);
      app.push('success', 'Operational limits updated.');
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="assistant-proposal assistant-proposal-limits">
      <div className="assistant-proposal-head">
        <span className="assistant-proposal-tag">{TAG.limits}</span>
        <strong>{action.title}</strong>
      </div>
      <RowsGrid rows={action.rows} />
      {action.rationale && <p className="assistant-proposal-why">{action.rationale}</p>}
      {over && (
        <p className="hint assistant-error">
          ⚠ Above the safety ceiling ({action.over.join(', ')}) — cannot apply.
        </p>
      )}
      <div className="assistant-proposal-actions">
        {done ? (
          <span className="hint assistant-ok">✓ Applied.</span>
        ) : canSetLimits ? (
          <button className="btn btn-primary" disabled={busy || over} onClick={() => void apply()}>
            {busy ? 'Applying…' : 'Apply limits'}
          </button>
        ) : (
          <span className="hint">Operational limits are set by a CISO.</span>
        )}
      </div>
      {err && <p className="hint assistant-error">⚠ {err}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- navigate */

type NavActionT = Extract<AssistantAction, { kind: 'navigate' }>;

function NavigateCard({ action }: { action: NavActionT }) {
  const navigate = useNavigate();
  return (
    <div className="assistant-proposal assistant-proposal-navigate">
      <div className="assistant-proposal-head">
        <span className="assistant-proposal-tag">{TAG.navigate}</span>
        <strong>{action.title}</strong>
      </div>
      {action.rationale && <p className="assistant-proposal-why">{action.rationale}</p>}
      <div className="assistant-proposal-actions">
        <button className="btn btn-primary" onClick={() => navigate(action.to)}>
          Open {action.screen} →
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- root */

export function AssistantActionCard({ action }: { action: AssistantAction }) {
  switch (action.kind) {
    case 'campaign':
      return <CampaignCard action={action} />;
    case 'target':
      return <TargetCard action={action} />;
    case 'limits':
      return <LimitsCard action={action} />;
    case 'navigate':
      return <NavigateCard action={action} />;
  }
}
