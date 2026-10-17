import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';
import type { ZoneSummary, ProtectedTarget, TargetAuthStatus } from './api.js';
import { useApp, canDo } from './context.js';
import { PageHead } from './pages.js';

/** Current scope comes from the target registry/configuration, never campaign history. */
export function protectedHost(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname
      .toLowerCase()
      .replace(/\.$/, '');
  } catch {
    return '';
  }
}

function activityDate(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  return new Date(value).toLocaleString();
}

const AUTH_BADGE: Record<TargetAuthStatus, { cls: string; label: string }> = {
  unauthorized: { cls: 'zs-none', label: 'Not authorized' },
  requested: { cls: 'zs-warn', label: 'Awaiting authorization' },
  authorized: { cls: 'zs-ok', label: 'Authorized' },
  revoked: { cls: 'zs-bad', label: 'Revoked' },
};

function ZoneHistory({ authorized }: { authorized: Set<string> | null }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [zones, setZones] = useState<ZoneSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  async function load() {
    setLoading(true);
    setError(false);
    try {
      setZones(await api.zones());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }
  const filtered = (zones ?? []).filter((z) =>
    z.host.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const current = Math.min(page, pages);
  return (
    <section className="card zone-history">
      <div className="zones-section-head">
        <button
          className="btn btn-ghost"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (!open && zones === null && !loading) void load();
          }}
        >
          Historical activity
        </button>
        <span
          className="hint"
          title="Retained campaign records do not establish current authorization, service health or a measured DRS score."
        >
          Previous campaigns only
        </span>
      </div>
      {open && (
        <>
          <div className="zones-tools">
            <input
              aria-label="Search history"
              placeholder="Search historical hosts"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
            <button className="btn btn-sm" disabled={loading} onClick={() => void load()}>
              Refresh history
            </button>
          </div>
          {loading ? (
            <p role="status">Loading history…</p>
          ) : error ? (
            <p role="alert">
              Couldn’t load historical activity.{' '}
              <button className="btn btn-sm" onClick={() => void load()}>
                Retry history
              </button>
            </p>
          ) : !filtered.length ? (
            <p className="empty">No historical activity{query ? ' matching this search' : ''}.</p>
          ) : (
            <>
              <div className="zones-table-wrap">
                <table className="zones-history-table">
                  <thead>
                    <tr>
                      <th>Host</th>
                      <th>Current access</th>
                      <th>Campaigns</th>
                      <th>Last activity</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice((current - 1) * 10, current * 10).map((z) => (
                      <tr key={z.host}>
                        <td>{z.host}</td>
                        <td>
                          <span className="hint">
                            {authorized === null
                              ? 'Unavailable'
                              : authorized.has(protectedHost(z.host))
                                ? 'Authorized'
                                : 'Outside authorized scope'}
                          </span>
                        </td>
                        <td>
                          {z.campaigns}
                          {z.suites ? ` · ${z.suites} suites` : ''}
                        </td>
                        <td title={z.lastTestAt}>{activityDate(z.lastTestAt)}</td>
                        <td>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={!protectedHost(z.host)}
                            onClick={() =>
                              navigate(
                                `/campaigns?tab=history&host=${encodeURIComponent(protectedHost(z.host))}&archived=1`,
                              )
                            }
                          >
                            View campaigns
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="zones-pagination">
                <span className="hint">
                  {filtered.length} hosts · page {current}/{pages}
                </span>
                <button
                  className="btn btn-sm"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                >
                  Previous
                </button>
                <button
                  className="btn btn-sm"
                  disabled={current === pages}
                  onClick={() => setPage(current + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

const EMPTY_FORM = { host: '', displayName: '', owner: '', notes: '', attestation: '' };

function TargetsPanel() {
  const app = useApp();
  const navigate = useNavigate();
  const canManage = canDo(
    app.role,
    'targetManage',
    app.authRequired,
    app.userMode,
    app.capabilities,
  );
  const canAuthorize = canDo(
    app.role,
    'targetAuthorize',
    app.authRequired,
    app.userMode,
    app.capabilities,
  );

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('authorized');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadVersion = useRef(0);
  const [targets, setTargets] = useState<ProtectedTarget[] | null>(null);
  const [envAllowlist, setEnvAllowlist] = useState<string[]>([]);
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
    const version = ++loadVersion.current;
    setRefreshing(true);
    api
      .targets()
      .then((r) => {
        if (version !== loadVersion.current) return;
        setTargets(r.targets);
        setEnvAllowlist(r.envAllowlist ?? []);
        setFailed(false);
      })
      .catch(() => {
        if (version !== loadVersion.current) return;
        setTargets((previous) => previous ?? []);
        setFailed(true);
      })
      .finally(() => {
        if (version === loadVersion.current) setRefreshing(false);
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
    if (!form.host.trim() || busyId || refreshing || failed) return;
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
      setFilter('all');
      setSelectedId(created.id);
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
      setFilter('all');
      setRequestingId(null);
      setReqAtt('');
      setEditingId(null);
      // Authorizing/revoking a target changes the effective allowlist; refresh the
      // shared /health posture so the campaign target picker reflects it at once.
      void app.refreshHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  }

  const configured = new Set(envAllowlist.map(protectedHost));
  const authorized = new Set([
    ...configured,
    ...(targets ?? [])
      .filter((t) => t.authStatus === 'authorized')
      .map((t) => protectedHost(t.host)),
  ]);
  const visible = (host: string, name: string, effective: boolean) =>
    `${host} ${name}`.toLowerCase().includes(query.trim().toLowerCase()) &&
    (filter === 'all' || (filter === 'authorized' ? effective : !effective));
  const envHosts = [...new Set(envAllowlist.map(protectedHost))].filter(
    (host) => host && !(targets ?? []).some((t) => protectedHost(t.host) === host),
  );
  const activeFor = (host: string) =>
    app.campaigns.filter(
      (c) => c.status === 'RUNNING' && protectedHost(c.target) === protectedHost(host),
    );
  const historyLink = (host: string) =>
    navigate(`/campaigns?tab=history&host=${encodeURIComponent(protectedHost(host))}`);
  const canCreate = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  const configure = (host: string) => {
    const recent = app.campaigns
      .filter((c) => protectedHost(c.target) === protectedHost(host))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
    let url = `https://${protectedHost(host)}/`;
    try {
      if (recent) url = new URL(recent.target).origin + '/';
    } catch {
      /* Keep editable default. */
    }
    navigate(`/campaigns?tab=templates&target=${encodeURIComponent(url)}`);
  };
  const activeCount = [
    ...new Set([...envHosts, ...(targets ?? []).map((t) => protectedHost(t.host))]),
  ].filter((host) => activeFor(host).length > 0).length;
  const noMatches =
    targets !== null &&
    !envHosts.some((h) => visible(h, '', true)) &&
    !targets.some((t) =>
      visible(t.host, t.displayName ?? '', authorized.has(protectedHost(t.host))),
    );

  return (
    <>
      <section className="card targets-panel zones-workspace">
        <div className="zones-section-head">
          <div>
            <h2>Current scope</h2>
            <span
              className="hint"
              title="Current authorization from registered targets and server configuration. Campaign history is not a source of authorization. Service availability is measured only during a campaign."
            >
              Authorization and activity
            </span>
          </div>
          <div className="zones-tools">
            <button
              className="btn btn-sm"
              disabled={refreshing || !!busyId}
              onClick={() => {
                load();
                void app.refresh();
                void app.refreshHealth();
              }}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            {canManage && (
              <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
                {showForm ? 'Cancel' : 'Add target'}
              </button>
            )}
          </div>
        </div>
        {!failed && targets !== null && (
          <div className="zones-summary">
            <span>
              <b>{targets.length + envHosts.length}</b> registered
            </span>
            <span>
              <b>{authorized.size}</b> authorized
            </span>
            <span>
              <b>{activeCount}</b> active
            </span>
            <span className="hint" title="No background health check is performed by this screen.">
              Service health: not monitored here
            </span>
          </div>
        )}
        <div className="zones-tools zones-search">
          <input
            aria-label="Search zones"
            placeholder="Search host, customer or name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Authorization filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All registered zones</option>
            <option value="authorized">Authorized</option>
            <option value="pending">Not authorized</option>
          </select>
        </div>
        {error && (
          <p className="hint assistant-error" role="alert">
            {error}
          </p>
        )}

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
                Optional. Authorization follows the current account policy.
              </span>
            </label>
            <div className="target-form-actions">
              <button
                className="btn btn-primary"
                type="submit"
                disabled={!!busyId || refreshing || failed || !form.host.trim()}
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

        {!failed && targets !== null && envHosts.some((h) => visible(h, '', true)) && (
          <ul className="target-list target-list-env">
            {envHosts
              .filter((h) => visible(h, '', true))
              .map((h) => (
                <li key={`env-${h}`} className="target-row target-row-env">
                  <div className="target-main">
                    <span className="target-host">{h}</span>
                    <span
                      className="zone-status zs-ok"
                      title="Authorization is managed in server configuration; it cannot be revoked from this screen."
                    >
                      Configured access
                    </span>
                  </div>
                  <div className="target-sub hint">
                    <span>
                      {activeFor(h).length
                        ? `${activeFor(h).length} campaign(s) running`
                        : 'No campaign running'}
                    </span>
                  </div>
                  <div className="target-actions">
                    {canCreate && (
                      <button
                        className="btn btn-sm btn-primary"
                        title="Review the URL and choose a template. No traffic starts here."
                        disabled={refreshing}
                        onClick={() => configure(h)}
                      >
                        Configure campaign
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={() => historyLink(h)}>
                      Campaigns
                    </button>
                    {activeFor(h)[0] && (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() =>
                          navigate(`/theater?run=${encodeURIComponent(activeFor(h)[0].id)}`)
                        }
                      >
                        Watch live
                      </button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        )}

        {targets === null ? (
          <p className="hint">
            <span className="spin" /> Loading targets…
          </p>
        ) : failed ? (
          <div className="empty" role="alert">
            Couldn&apos;t load targets.{' '}
            <button className="btn btn-sm" onClick={load}>
              Retry
            </button>
          </div>
        ) : targets.length === 0 ? (
          envHosts.length === 0 ? (
            <p className="empty">No zones configured. Add an authorized target to get started.</p>
          ) : null
        ) : (
          <ul className="target-list">
            {targets
              .filter((t) =>
                visible(t.host, t.displayName ?? '', authorized.has(protectedHost(t.host))),
              )
              .sort((a, b) => a.host.localeCompare(b.host))
              .map((t) => {
                const badge = AUTH_BADGE[t.authStatus];
                const busy = busyId !== null || refreshing;
                return (
                  <li key={t.id} className="target-row">
                    <div className="target-main">
                      <span className="target-host">{t.host}</span>
                      <span className={`zone-status ${badge.cls}`}>{badge.label}</span>
                      {configured.has(protectedHost(t.host)) && (
                        <span
                          className="zone-status zs-ok"
                          title="Server configuration independently authorizes this host, even if its registration is revoked."
                        >
                          Configured access
                        </span>
                      )}
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
                      <span className="hint">
                        {activeFor(t.host).length
                          ? `${activeFor(t.host).length} campaign(s) running`
                          : 'No campaign running'}
                      </span>
                      {canCreate && (
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={refreshing || !authorized.has(protectedHost(t.host))}
                          title="Review the URL and choose a template. Authorization is required; no traffic starts here."
                          onClick={() => configure(t.host)}
                        >
                          Configure campaign
                        </button>
                      )}
                      <button className="btn btn-sm" onClick={() => historyLink(t.host)}>
                        Campaigns
                      </button>
                      {activeFor(t.host)[0] && (
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() =>
                            navigate(`/theater?run=${encodeURIComponent(activeFor(t.host)[0].id)}`)
                          }
                        >
                          Watch live
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-ghost"
                        aria-expanded={selectedId === t.id}
                        onClick={() => {
                          setSelectedId(selectedId === t.id ? null : t.id);
                          setEditingId(null);
                          setRequestingId(null);
                        }}
                      >
                        {selectedId === t.id ? 'Close details' : 'Details'}
                      </button>
                    </div>
                    {selectedId === t.id && (
                      <div className="zone-target-detail">
                        <p className="hint">Configuration updated: {activityDate(t.updatedAt)}</p>
                        {t.notes && <p className="hint">{t.notes}</p>}
                        <div className="target-actions">
                          {/* Existing server capability and authorization rules remain authoritative. */}
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
                          {canManage &&
                            (t.authStatus === 'unauthorized' || t.authStatus === 'revoked') && (
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
                              onClick={() =>
                                editingId === t.id ? setEditingId(null) : openEdit(t)
                              }
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
                            <span className="hint">awaiting authorization</span>
                          )}
                        </div>

                        {editingId === t.id && (
                          <div className="target-request target-edit">
                            <div className="target-form-grid">
                              <input
                                value={editForm.displayName}
                                onChange={(e) =>
                                  setEditForm({ ...editForm, displayName: e.target.value })
                                }
                                placeholder="Zone / customer name"
                                aria-label="Zone name"
                              />
                              <input
                                value={editForm.owner}
                                onChange={(e) =>
                                  setEditForm({ ...editForm, owner: e.target.value })
                                }
                                placeholder="Owner / contact"
                                aria-label="Owner"
                              />
                              <input
                                value={editForm.notes}
                                onChange={(e) =>
                                  setEditForm({ ...editForm, notes: e.target.value })
                                }
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
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
        {!failed && noMatches && (targets?.length || envHosts.length) ? (
          <p className="empty">No zones match this filter.</p>
        ) : null}
      </section>
      <ZoneHistory authorized={failed || targets === null ? null : authorized} />
    </>
  );
}

export function ZonesPage() {
  return (
    <>
      <PageHead title="Protected zones" />
      <TargetsPanel />
    </>
  );
}
