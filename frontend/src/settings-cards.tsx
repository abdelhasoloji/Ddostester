import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useApp, canDo, roleLabel } from './context.js';
import { api, getGrafanaBase, setGrafanaBase, grafanaDashUrl } from './api.js';
import type { HardCaps, ManagedUser, Role } from './api.js';
import { AiSupportButton } from './ui.js';

export function PurgeCard() {
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
      <div className="card-head">
        <h2>Purge campaigns</h2>
        <AiSupportButton
          title="Purge campaigns"
          context="destructive maintenance action to purge settled or all campaigns from the store."
        />
      </div>
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

export function UsersCard() {
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

  const add = async (e: FormEvent) => {
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
      <div className="card-head">
        <h2>Users &amp; access</h2>
        <AiSupportButton
          title="Users & access"
          context="platform user administration — accounts, roles (engineer/ciso/admin/viewer) and access."
        />
      </div>
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
export function LimitsCard() {
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

  const save = async (e: FormEvent) => {
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
      <div className="card-head">
        <h2>Operational limits (admin)</h2>
        <AiSupportButton
          title="Operational limits (admin)"
          context="the operational caps (maxRps/concurrency/duration) under the frozen HARD_CAPS ceiling."
        />
      </div>
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

export function NotificationsCard() {
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
      <div className="card-head">
        <h2>Notifications</h2>
        <AiSupportButton
          title="Notifications"
          context="the notification sinks (Slack / generic webhook) fired on campaign completion, kill or WRS regression."
        />
      </div>
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
export function ObservabilityCard() {
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
      <div className="card-head">
        <h2>Observability (Grafana)</h2>
        <AiSupportButton
          title="Observability (Grafana)"
          context="the Grafana/Prometheus observability wiring — base URL and run dashboards."
        />
      </div>
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
