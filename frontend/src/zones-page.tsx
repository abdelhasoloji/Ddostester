import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';
import type { ZoneSummary, ProtectedTarget, TargetAuthStatus } from './api.js';
import { useApp, canDo } from './context.js';
import { PageHead } from './pages.js';
import { wrsClass, AiSupportButton } from './ui.js';

/**
 * Protected zones — the WEDOS-Protection framing: the estate seen per protected
 * customer/host, each with its assurance posture (WRS, DRS reached, edge
 * absorption, activity). Derived from the existing campaigns; a zone is the unit
 * WEDOS Protection is sold and measured by. See docs/vision-proving-ground.md.
 *
 * Targets are onboarded here under governance: registering a host is metadata
 * only; a CISO must authorize it (separately from the requester) before any
 * campaign can run against it — authorization adds the host to the effective
 * allowlist. See backend/src/modules/targets/model.ts.
 */
function fmtWhen(iso?: string): string {
  if (!iso) return 'never tested';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never tested';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

const AUTH_BADGE: Record<TargetAuthStatus, { cls: string; label: string }> = {
  unauthorized: { cls: 'zs-none', label: 'unauthorized' },
  requested: { cls: 'zs-warn', label: '⏳ auth requested' },
  authorized: { cls: 'zs-ok', label: '✓ authorized' },
  revoked: { cls: 'zs-bad', label: '⃠ revoked' },
};

function ZoneCard({ z, onOpen }: { z: ZoneSummary; onOpen: () => void }) {
  const status = z.running
    ? { cls: 'zs-live', label: '● testing' }
    : z.regression
      ? { cls: 'zs-bad', label: '▼ regression' }
      : z.lastLevel && ['A+', 'A', 'B'].includes(z.lastLevel)
        ? { cls: 'zs-ok', label: '✓ resilient' }
        : z.lastWrs != null
          ? { cls: 'zs-warn', label: 'needs attention' }
          : { cls: 'zs-none', label: 'not tested' };
  return (
    <button type="button" className="zone-card" onClick={onOpen} aria-label={`Open ${z.host}`}>
      <div className="zone-head">
        <span className="zone-host">🛡 {z.host}</span>
        <span className={`zone-status ${status.cls}`}>{status.label}</span>
      </div>
      <div className="zone-wrs">
        {z.lastWrs != null && z.lastLevel ? (
          <span className={`wrs ${wrsClass(z.lastLevel)}`} title="Latest WRS">
            <span className="wrs-score">{z.lastWrs}</span> {z.lastLevel}
          </span>
        ) : (
          <span className="hint">No score yet</span>
        )}
        {z.meanWrs != null && z.lastWrs != null && <span className="hint">avg {z.meanWrs}</span>}
      </div>
      <dl className="zone-meta">
        <div>
          <dt>DRS reached</dt>
          <dd>{z.maxDrs != null ? `DRS ${z.maxDrs}` : '—'}</dd>
        </div>
        <div
          className="zone-absorb"
          title="Share of the offered attack load the edge soaked up before it reached origin. 0% = the edge never engaged (traffic passed straight to origin); a high % with the probe still up = protection working."
        >
          <dt>Edge absorbed</dt>
          <dd>
            {z.lastAbsorbedPct == null ? (
              '—'
            ) : z.lastAbsorbedPct === 0 ? (
              <span className="zone-absorb-v zone-absorb-idle">0% · edge idle</span>
            ) : (
              <span className={`zone-absorb-v${z.lastAbsorbedPct >= 60 ? ' zone-absorb-ok' : ''}`}>
                {z.lastAbsorbedPct}%
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Campaigns</dt>
          <dd>
            {z.campaigns}
            {z.suites > 0 ? ` · ${z.suites} suite${z.suites === 1 ? '' : 's'}` : ''}
          </dd>
        </div>
      </dl>
      <div className="zone-foot hint">Last test: {fmtWhen(z.lastTestAt)}</div>
    </button>
  );
}

const EMPTY_FORM = { host: '', displayName: '', owner: '', notes: '', attestation: '' };

function TargetsPanel() {
  const app = useApp();
  const canManage = canDo(app.role, 'targetManage', app.authRequired);
  const canAuthorize = canDo(app.role, 'targetAuthorize', app.authRequired);

  const [targets, setTargets] = useState<ProtectedTarget[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-row attestation entry for requesting authorization on an existing target.
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [reqAtt, setReqAtt] = useState('');
  // Per-row inline metadata editing.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ displayName: '', owner: '', notes: '' });

  function openEdit(t: ProtectedTarget) {
    setEditingId(t.id);
    setEditForm({ displayName: t.displayName ?? '', owner: t.owner ?? '', notes: t.notes ?? '' });
    setRequestingId(null);
  }

  const load = () => {
    api
      .targets()
      .then((r) => {
        setTargets(r.targets);
        setFailed(false);
      })
      .catch(() => {
        setTargets([]);
        setFailed(true);
      });
  };
  useEffect(load, []);

  // Pre-fill and open the onboarding form when the assistant queues a target.
  useEffect(() => {
    if (!app.draftTarget) return;
    setForm({ ...EMPTY_FORM, ...app.draftTarget });
    setShowForm(true);
    app.clearDraftTarget();
  }, [app.draftTarget]);

  const upsert = (t: ProtectedTarget) =>
    setTargets((prev) => {
      const next = (prev ?? []).filter((x) => x.id !== t.id);
      next.push(t);
      return next.sort((a, b) => a.host.localeCompare(b.host));
    });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.host.trim() || busyId) return;
    setBusyId('new');
    setError(null);
    try {
      const created = await api.registerTarget({
        host: form.host.trim(),
        displayName: form.displayName.trim() || undefined,
        owner: form.owner.trim() || undefined,
        notes: form.notes.trim() || undefined,
        attestation: form.attestation.trim() || undefined,
      });
      upsert(created);
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register target.');
    } finally {
      setBusyId(null);
    }
  }

  async function act(
    id: string,
    fn: () => Promise<ProtectedTarget | { ok: boolean }>,
    del = false,
  ) {
    setBusyId(id);
    setError(null);
    try {
      const r = await fn();
      if (del) setTargets((prev) => (prev ?? []).filter((x) => x.id !== id));
      else upsert(r as ProtectedTarget);
      setRequestingId(null);
      setReqAtt('');
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card targets-panel">
      <div className="targets-head">
        <div>
          <div className="card-head">
            <h3>Protected targets</h3>
            <AiSupportButton
              title="Protected targets"
              context="the registered protected zones/targets and their authorization state (a CISO must authorize before any test)."
            />
          </div>
          <p className="hint">
            Onboard a host as a protected zone. Registering is metadata only — a CISO must authorize
            it (separately from the requester) before any test can run against it.
          </p>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Cancel' : '+ Add target'}
          </button>
        )}
      </div>

      {error && <p className="hint assistant-error">⚠ {error}</p>}

      {showForm && canManage && (
        <form className="target-form" onSubmit={submit}>
          <div className="target-form-grid">
            <label>
              Host <span className="req">*</span>
              <input
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="app.customer.eu"
                autoFocus
              />
            </label>
            <label>
              Zone / customer name
              <input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="Customer Bank"
              />
            </label>
            <label>
              Owner / contact
              <input
                value={form.owner}
                onChange={(e) => setForm({ ...form, owner: e.target.value })}
                placeholder="soc@customer.eu"
              />
            </label>
          </div>
          <label>
            Notes
            <input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Scope, maintenance windows, contacts…"
            />
          </label>
          <label>
            Authorization attestation (optional — request testing now)
            <textarea
              value={form.attestation}
              onChange={(e) => setForm({ ...form, attestation: e.target.value })}
              rows={2}
              placeholder="I attest WEDOS is authorized to run bounded resilience tests against this host (ownership / signed mandate, scope, RoE)."
            />
            <span className="hint">
              Leave blank to register the zone without requesting authorization. Filling it submits
              a request a CISO will validate.
            </span>
          </label>
          <div className="target-form-actions">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busyId === 'new' || !form.host.trim()}
            >
              {busyId === 'new'
                ? 'Registering…'
                : form.attestation.trim()
                  ? 'Register & request'
                  : 'Register zone'}
            </button>
          </div>
        </form>
      )}

      {targets === null ? (
        <p className="hint">
          <span className="spin" /> Loading targets…
        </p>
      ) : failed ? (
        <div className="empty">
          Couldn&apos;t load targets.{' '}
          <button className="btn btn-sm" onClick={load}>
            Retry
          </button>
        </div>
      ) : targets.length === 0 ? (
        <p className="hint">No targets registered yet.</p>
      ) : (
        <ul className="target-list">
          {targets.map((t) => {
            const badge = AUTH_BADGE[t.authStatus];
            const busy = busyId === t.id;
            return (
              <li key={t.id} className="target-row">
                <div className="target-main">
                  <span className="target-host">{t.host}</span>
                  <span className={`zone-status ${badge.cls}`}>{badge.label}</span>
                  {t.displayName && <span className="hint">{t.displayName}</span>}
                </div>
                <div className="target-sub hint">
                  {t.owner && <span>owner: {t.owner}</span>}
                  {t.authStatus === 'requested' && t.authRequestedBy && (
                    <span>requested by {t.authRequestedBy}</span>
                  )}
                  {t.authStatus === 'authorized' && t.authorizedBy && (
                    <span>authorized by {t.authorizedBy}</span>
                  )}
                  {t.authAttestation && (
                    <span title={t.authAttestation}>· attestation on file</span>
                  )}
                </div>

                <div className="target-actions">
                  {/* CISO governance: grant / revoke */}
                  {canAuthorize && t.authStatus === 'requested' && (
                    <>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        onClick={() => void act(t.id, () => api.authorizeTarget(t.id))}
                      >
                        Authorize
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void act(t.id, () => api.revokeTarget(t.id))}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {canAuthorize && t.authStatus === 'authorized' && (
                    <button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void act(t.id, () => api.revokeTarget(t.id))}
                    >
                      Revoke
                    </button>
                  )}
                  {/* Operator: request authorization (unauthorized / revoked) */}
                  {canManage && (t.authStatus === 'unauthorized' || t.authStatus === 'revoked') && (
                    <button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => {
                        setRequestingId(requestingId === t.id ? null : t.id);
                        setReqAtt('');
                      }}
                    >
                      Request authorization
                    </button>
                  )}
                  {canManage && (
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={busy}
                      onClick={() => (editingId === t.id ? setEditingId(null) : openEdit(t))}
                    >
                      Edit
                    </button>
                  )}
                  {canManage && t.authStatus !== 'authorized' && (
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={busy}
                      onClick={() => void act(t.id, () => api.deleteTarget(t.id), true)}
                    >
                      Delete
                    </button>
                  )}
                  {t.authStatus === 'requested' && !canAuthorize && (
                    <span className="hint">awaiting CISO</span>
                  )}
                </div>

                {editingId === t.id && (
                  <div className="target-request target-edit">
                    <div className="target-form-grid">
                      <input
                        value={editForm.displayName}
                        onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
                        placeholder="Zone / customer name"
                        aria-label="Zone name"
                      />
                      <input
                        value={editForm.owner}
                        onChange={(e) => setEditForm({ ...editForm, owner: e.target.value })}
                        placeholder="Owner / contact"
                        aria-label="Owner"
                      />
                      <input
                        value={editForm.notes}
                        onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                        placeholder="Notes"
                        aria-label="Notes"
                      />
                    </div>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void act(t.id, () =>
                          api.updateTarget(t.id, {
                            displayName: editForm.displayName.trim(),
                            owner: editForm.owner.trim(),
                            notes: editForm.notes.trim(),
                          }),
                        )
                      }
                    >
                      Save
                    </button>
                  </div>
                )}

                {requestingId === t.id && (
                  <div className="target-request">
                    <textarea
                      value={reqAtt}
                      onChange={(e) => setReqAtt(e.target.value)}
                      rows={2}
                      placeholder="Authorization attestation (ownership / signed mandate, scope, RoE)…"
                    />
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busy || reqAtt.trim().length < 10}
                      onClick={() =>
                        void act(t.id, () => api.requestTargetAuth(t.id, reqAtt.trim()))
                      }
                    >
                      Submit request
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ZonesPage() {
  const navigate = useNavigate();
  const [zones, setZones] = useState<ZoneSummary[] | null>(null);
  const [errored, setErrored] = useState(false);
  const load = () => {
    setErrored(false);
    api
      .zones()
      .then((z) => {
        setZones(z);
      })
      .catch(() => {
        setZones([]);
        setErrored(true);
      });
  };
  useEffect(load, []);

  return (
    <>
      <PageHead
        title="Protected zones"
        sub="Assurance per protected customer — how well the WEDOS edge holds for each host, at a glance. Onboard a target below; open a zone to see its campaigns."
      />

      <TargetsPanel />

      {zones === null ? (
        <p className="hint">
          <span className="spin" /> Loading zones…
        </p>
      ) : errored ? (
        <div className="empty">
          Couldn&apos;t load protected zones.{' '}
          <button className="btn btn-sm" onClick={load}>
            Retry
          </button>
        </div>
      ) : zones.length === 0 ? (
        <div className="empty">
          No protected zones yet — run a campaign against an authorized target and it appears here.
        </div>
      ) : (
        <div className="zones-grid">
          {zones.map((z) => (
            <ZoneCard
              key={z.host}
              z={z}
              onOpen={() => navigate(`/campaigns?q=${encodeURIComponent(z.host)}`)}
            />
          ))}
        </div>
      )}
    </>
  );
}
