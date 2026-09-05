import { useCallback, useEffect, useState } from 'react';
import { api, setToken, getToken, reportUrl, complianceUrl } from './api.js';
import type { Campaign, CampaignRun, CampaignStatus, WrsBreakdown, Role, AuditEntry, WrsSeries } from './api.js';

const HARD_CAPS = { maxRps: 2000, concurrency: 500, maxDurationSec: 900 };

// ---------- toasts ----------
interface Toast {
  id: number;
  kind: 'error' | 'success' | 'info';
  msg: string;
}
let toastSeq = 0;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], msg: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return { toasts, push };
}

// ---------- helpers ----------
interface Identity {
  email: string;
  role: Role;
}
type Perm = 'create' | 'approve' | 'execute' | 'kill';
const PERMS: Record<Role, Perm[]> = {
  officer: ['create', 'approve', 'execute', 'kill'],
  engineer: ['create', 'execute', 'kill'],
  viewer: ['kill'],
};
const roleLabel: Record<Role, string> = {
  officer: 'Security Officer',
  engineer: 'Security Engineer',
  viewer: 'SOC / NOC',
};
function canDo(role: Role | null, perm: Perm, authRequired: boolean): boolean {
  if (!authRequired) return true; // mode dev : toutes les actions
  return role ? PERMS[role].includes(perm) : false;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const badgeLabel: Record<CampaignStatus, string> = {
  PENDING_APPROVAL: 'En attente',
  APPROVED: 'Approuvée',
  REJECTED: 'Rejetée',
  RUNNING: 'En cours',
  COMPLETED: 'Terminée',
  KILLED_AUTO: 'Kill auto',
  KILLED_MANUAL: 'Kill manuel',
};

function StatusBadge({ status }: { status: CampaignStatus }) {
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

function WrsPill({ wrs }: { wrs: WrsBreakdown }) {
  return (
    <span className={`wrs ${wrsClass(wrs.level)}`} title="WEDOS Resiliency Score">
      <span className="wrs-score">{wrs.wrs}</span> {wrs.level}
    </span>
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
  body: '',
};

function Sparkline({ points, regression }: { points: { wrs: number }[]; regression: boolean }) {
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
  return (
    <svg width={w} height={h} className="spark" aria-hidden="true">
      <line x1={pad} y1={h - pad - (70 / 100) * (h - 2 * pad)} x2={w - pad} y2={h - pad - (70 / 100) * (h - 2 * pad)} className="spark-thresh" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="3" fill={color} />
    </svg>
  );
}

function BrandHeader({ right }: { right: React.ReactNode }) {
  return (
    <header className="brandbar">
      <div className="brand-lockup">
        <img className="brand-logo logo-light" src="/wedos-logo.png" alt="WEDOS" />
        <img className="brand-logo logo-dark" src="/wedos-logo-white.png" alt="WEDOS" />
        <span className="brand-tag">ShieldTest · Control Plane</span>
      </div>
      {right}
    </header>
  );
}

export function App() {
  const [allowed, setAllowed] = useState<string[]>([]);
  const [authRequired, setAuthRequired] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [operator, setOperator] = useState(() => localStorage.getItem('operator') ?? '');
  const [form, setForm] = useState({ ...emptyForm });
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [runs, setRuns] = useState<Record<string, CampaignRun>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmExec, setConfirmExec] = useState<Campaign | null>(null);
  const [approveFor, setApproveFor] = useState<Campaign | null>(null);
  const [auditRows, setAuditRows] = useState<AuditEntry[] | null>(null);
  const [wrsSeries, setWrsSeries] = useState<WrsSeries[]>([]);
  const { toasts, push } = useToasts();

  const role = identity?.role ?? null;

  const refresh = useCallback(() => {
    api.listCampaigns().then(setCampaigns).catch((e) => push('error', e.message));
  }, [push]);

  const loadHistory = useCallback(() => {
    api.wrsHistory().then(setWrsSeries).catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .health()
      .then(async (h) => {
        setAllowed(h.allowedTargets);
        setAuthRequired(h.authRequired);
        if (h.authRequired && getToken()) {
          try {
            const me = await api.me();
            if (me.email && me.role) setIdentity({ email: me.email, role: me.role });
            else setToken(null);
          } catch {
            setToken(null);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => setAuthChecked(true));
  }, []);

  const ready = authChecked && (!authRequired || identity !== null);
  useEffect(() => {
    if (ready) {
      refresh();
      loadHistory();
    }
  }, [ready, refresh, loadHistory]);

  const anyRunning = campaigns.some((c) => c.status === 'RUNNING');
  useEffect(() => {
    if (!anyRunning || !ready) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [anyRunning, ready, refresh]);

  useEffect(() => localStorage.setItem('operator', operator), [operator]);

  const setBusyFor = (id: string, v: boolean) => setBusy((b) => ({ ...b, [id]: v }));

  const targetHost = hostOf(form.target);
  const probeHost = hostOf(form.probeUrl);
  const targetAllowed = targetHost !== null && allowed.includes(targetHost);
  const probeAllowed = probeHost !== null && allowed.includes(probeHost);
  const capsOk =
    form.maxRps > 0 &&
    form.maxRps <= HARD_CAPS.maxRps &&
    form.concurrency >= 1 &&
    form.concurrency <= HARD_CAPS.concurrency &&
    form.maxDurationSec >= 1 &&
    form.maxDurationSec <= HARD_CAPS.maxDurationSec;
  const identityOk = authRequired ? identity !== null : operator.trim() !== '';
  const canCreate = canDo(role, 'create', authRequired);
  const formValid =
    form.name.trim() !== '' && identityOk && targetAllowed && probeAllowed && capsOk && attested && canCreate;

  const login = async (email: string, password: string) => {
    const r = await api.login(email, password);
    setToken(r.token);
    setIdentity({ email: r.email, role: r.role });
  };
  const logout = () => {
    setToken(null);
    setIdentity(null);
    setCampaigns([]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formValid) return;
    try {
      await api.createCampaign({
        name: form.name,
        createdBy: authRequired ? identity?.email : operator,
        target: form.target,
        probeUrl: form.probeUrl,
        vector: form.vector,
        body: form.vector === 'http-post' ? form.body : undefined,
        maxRps: Number(form.maxRps),
        concurrency: Number(form.concurrency),
        maxDurationSec: Number(form.maxDurationSec),
        authorized: true,
      });
      setForm({ ...emptyForm });
      setAttested(false);
      push('success', 'Campagne créée — en attente d’approbation.');
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    }
  };

  const doApprove = async (c: Campaign, approvedBy: string, decision: 'APPROVED' | 'REJECTED', reason: string) => {
    setApproveFor(null);
    setBusyFor(c.id, true);
    try {
      await api.approve(c.id, { approvedBy, decision, reason: reason || undefined });
      push('success', decision === 'APPROVED' ? 'Campagne approuvée.' : 'Campagne rejetée.');
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    } finally {
      setBusyFor(c.id, false);
    }
  };

  const doExecute = async (c: Campaign) => {
    setConfirmExec(null);
    setBusyFor(c.id, true);
    refresh();
    try {
      const run = await api.execute(c.id);
      setRuns((r) => ({ ...r, [c.id]: run }));
      setExpanded(c.id);
      push(
        run.status === 'COMPLETED' ? 'success' : 'info',
        `Exécution ${badgeLabel[run.status]} — WRS ${run.wrs.wrs} (${run.wrs.level}).`,
      );
      refresh();
      loadHistory();
    } catch (err) {
      push('error', (err as Error).message);
      refresh();
    } finally {
      setBusyFor(c.id, false);
    }
  };

  const doKill = async (c: Campaign) => {
    try {
      await api.kill(c.id);
      push('info', 'Kill switch déclenché.');
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    }
  };

  const toggleAudit = async () => {
    if (auditRows !== null) {
      setAuditRows(null);
      return;
    }
    try {
      setAuditRows(await api.audit(100));
    } catch (err) {
      push('error', (err as Error).message);
    }
  };

  const toggleDetails = async (c: Campaign) => {
    if (expanded === c.id) {
      setExpanded(null);
      return;
    }
    setExpanded(c.id);
    if (!runs[c.id] && c.runId) {
      try {
        const run = await api.getRun(c.runId);
        setRuns((r) => ({ ...r, [c.id]: run }));
      } catch {
        /* pas de run détaillé disponible */
      }
    }
  };

  // --- écran de connexion (auth activée, non connecté) ---
  if (authChecked && authRequired && !identity) {
    return (
      <>
        <div className="accent-line" />
        <div className="app">
          <BrandHeader right={null} />
          <Login onLogin={login} />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="accent-line" />
      <div className="app">
        <BrandHeader
          right={
            authRequired && identity ? (
              <div className="identity">
                <span className="hint">
                  {identity.email} · <b>{roleLabel[identity.role]}</b>
                </span>
                <button className="btn btn-sm btn-ghost" onClick={logout}>
                  Déconnexion
                </button>
              </div>
            ) : (
              <div className="identity">
                <label htmlFor="op">Opérateur</label>
                <input
                  id="op"
                  placeholder="prenom.nom@wedos"
                  value={operator}
                  onChange={(e) => setOperator(e.target.value)}
                />
              </div>
            )
          }
        />
        <p className="subtitle" style={{ marginBottom: '.5rem' }}>
          Cibles autorisées : <code>{allowed.join(', ') || '—'}</code> · générateur HTTP borné
          (aucun vecteur volumétrique).
        </p>

        {canCreate && (
          <section className="card">
            <h2>Nouvelle campagne</h2>
            <form className="grid" onSubmit={submit}>
              <div className="field">
                <label>Nom</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="field">
                <label>Vecteur</label>
                <select value={form.vector} onChange={(e) => setForm({ ...form, vector: e.target.value })}>
                  <option value="http-get">http-get</option>
                  <option value="http-post">http-post</option>
                </select>
              </div>

              <div className="field">
                <label>Cible (URL)</label>
                <input
                  className={form.target && !targetAllowed ? 'invalid' : ''}
                  value={form.target}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                />
                {form.target && !targetAllowed && (
                  <span className="hint" style={{ color: 'var(--danger)' }}>
                    Hôte hors liste blanche — sera refusé.
                  </span>
                )}
              </div>
              <div className="field">
                <label>Sonde (URL)</label>
                <input
                  className={form.probeUrl && !probeAllowed ? 'invalid' : ''}
                  value={form.probeUrl}
                  onChange={(e) => setForm({ ...form, probeUrl: e.target.value })}
                />
                {form.probeUrl && !probeAllowed && (
                  <span className="hint" style={{ color: 'var(--danger)' }}>
                    Hôte hors liste blanche — sera refusé.
                  </span>
                )}
              </div>

              <div className="field">
                <label>Max RPS</label>
                <input
                  type="number"
                  value={form.maxRps}
                  onChange={(e) => setForm({ ...form, maxRps: Number(e.target.value) })}
                />
                <span className="hint">plafond {HARD_CAPS.maxRps}</span>
              </div>
              <div className="field">
                <label>Concurrence</label>
                <input
                  type="number"
                  value={form.concurrency}
                  onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })}
                />
                <span className="hint">1–{HARD_CAPS.concurrency}</span>
              </div>
              <div className="field">
                <label>Durée max (s)</label>
                <input
                  type="number"
                  value={form.maxDurationSec}
                  onChange={(e) => setForm({ ...form, maxDurationSec: Number(e.target.value) })}
                />
                <span className="hint">≤ {HARD_CAPS.maxDurationSec}s (15 min)</span>
              </div>

              {form.vector === 'http-post' && (
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>Corps de la requête (POST)</label>
                  <textarea rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
                </div>
              )}

              <label className="attest">
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
                <span>
                  J’atteste que la cible m’appartient ou que je dispose d’un <b>mandat écrit</b> pour la
                  tester (interne WEDOS / périmètre autorisé).
                </span>
              </label>

              <button type="submit" className="btn btn-primary btn-block" disabled={!formValid}>
                Soumettre pour approbation
              </button>
            </form>
          </section>
        )}

        {wrsSeries.length > 0 && (
          <>
            <h2 className="section-title">Historique WRS par cible</h2>
            <div className="card" style={{ display: 'grid', gap: '.75rem' }}>
              {wrsSeries.map((s) => {
                const last = s.points[s.points.length - 1];
                return (
                  <div key={s.target} className="wrs-hist">
                    <div className="wrs-hist-main">
                      <code>{s.target}</code>
                      <span className={`wrs ${wrsClass(last.level as WrsBreakdown['level'])}`}>
                        <span className="wrs-score">{last.wrs}</span> {last.level}
                      </span>
                      <span className="hint">{s.points.length} exécution(s)</span>
                      {s.regression && (
                        <span className="badge badge-REJECTED" title="Chute de plus de 10 points">
                          ▼ Régression −{s.drop}
                        </span>
                      )}
                    </div>
                    <Sparkline points={s.points} regression={s.regression} />
                  </div>
                );
              })}
            </div>
          </>
        )}

        <h2 className="section-title">
          Campagnes {anyRunning && <span className="hint">· actualisation auto…</span>}
          <a
            className="btn btn-sm btn-ghost"
            style={{ marginLeft: '.5rem' }}
            href={complianceUrl()}
            target="_blank"
            rel="noreferrer"
          >
            Rapport de conformité ↗
          </a>
        </h2>
        <div className="campaigns">
          {campaigns.length === 0 && <div className="empty">Aucune campagne pour l’instant.</div>}
          {campaigns.map((c) => {
            const run = runs[c.id];
            const isBusy = busy[c.id];
            return (
              <div className="campaign" key={c.id}>
                <div className="campaign-head">
                  <span className="campaign-name">{c.name}</span>
                  <StatusBadge status={c.status} />
                  {c.wrs && <WrsPill wrs={c.wrs} />}
                  <div className="campaign-actions">
                    {c.status === 'PENDING_APPROVAL' && canDo(role, 'approve', authRequired) && (
                      <button className="btn btn-sm" disabled={isBusy} onClick={() => setApproveFor(c)}>
                        Approuver / Rejeter
                      </button>
                    )}
                    {c.status === 'APPROVED' && canDo(role, 'execute', authRequired) && (
                      <button className="btn btn-sm btn-primary" disabled={isBusy} onClick={() => setConfirmExec(c)}>
                        {isBusy ? <span className="spin" /> : null}Exécuter
                      </button>
                    )}
                    {c.status === 'RUNNING' && canDo(role, 'kill', authRequired) && (
                      <button className="btn btn-sm btn-danger" onClick={() => doKill(c)}>
                        Kill switch
                      </button>
                    )}
                    {c.runId && (
                      <a className="btn btn-sm btn-ghost" href={reportUrl(c.runId)} target="_blank" rel="noreferrer">
                        Rapport ↗
                      </a>
                    )}
                    {(run || c.runId) && (
                      <button className="btn btn-sm btn-ghost" onClick={() => toggleDetails(c)}>
                        {expanded === c.id ? 'Masquer' : 'Détails'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="campaign-meta">
                  <span>
                    Cible : <code>{c.target}</code>
                  </span>
                  <span>{c.vector}</span>
                  <span>
                    {c.maxRps} rps · {c.concurrency} conc · {c.maxDurationSec}s
                  </span>
                  <span>
                    par {c.createdBy}
                    {c.approvedBy ? ` · appr. ${c.approvedBy}` : ''}
                  </span>
                </div>

                {expanded === c.id && run && (
                  <div className="details">
                    <div className="metrics">
                      <div className="metric"><div className="k">Requêtes</div><div className="v">{run.generator.totalRequests}</div></div>
                      <div className="metric"><div className="k">Succès / échecs</div><div className="v">{run.generator.successful} / {run.generator.failed}</div></div>
                      <div className="metric"><div className="k">RPS réel</div><div className="v">{run.generator.actualRps}</div></div>
                      <div className="metric"><div className="k">Latence p95</div><div className="v">{run.generator.latencyMs.p95} ms</div></div>
                      <div className="metric"><div className="k">Sonde 5xx</div><div className="v">{run.probe.errorRate5xx}%</div></div>
                      <div className="metric"><div className="k">Dispo sonde</div><div className="v">{run.probe.available}/{run.probe.samples}</div></div>
                    </div>
                    <div className="wrs-breakdown">
                      <span>Détection <b>{run.wrs.detection}</b></span>
                      <span>Mitigation <b>{run.wrs.mitigation}</b></span>
                      <span>Disponibilité <b>{run.wrs.availability}</b></span>
                      <span>Collatéral <b>{run.wrs.collateral}</b></span>
                    </div>
                  </div>
                )}
                {expanded === c.id && !run && (
                  <div className="details"><span className="hint">Aucune métrique détaillée disponible.</span></div>
                )}
              </div>
            );
          })}
        </div>

        <h2 className="section-title">
          Journal d’audit{' '}
          <button className="btn btn-sm btn-ghost" onClick={toggleAudit}>
            {auditRows !== null ? 'Masquer' : 'Afficher'}
          </button>
        </h2>
        {auditRows !== null && (
          <div className="card" style={{ marginTop: '.5rem' }}>
            {auditRows.length === 0 && <span className="hint">Aucune entrée.</span>}
            {auditRows.map((a) => (
              <div key={a.id} className="audit-row">
                <span className="audit-time">{new Date(a.at).toLocaleString()}</span>
                <span className="audit-actor">{a.actor}</span>
                <span className={`audit-action a-${a.action.replace('.', '-')}`}>{a.action}</span>
                <span className="audit-detail">{a.detail ?? ''}</span>
              </div>
            ))}
          </div>
        )}

        {confirmExec && (
          <ExecuteModal
            campaign={confirmExec}
            onCancel={() => setConfirmExec(null)}
            onConfirm={() => doExecute(confirmExec)}
          />
        )}
        {approveFor && (
          <ApproveModal
            campaign={approveFor}
            authRequired={authRequired}
            identityEmail={identity?.email ?? operator}
            onCancel={() => setApproveFor(null)}
            onDecide={doApprove}
          />
        )}

        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
          ))}
        </div>
      </div>
    </>
  );
}

function Login({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onLogin(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" style={{ maxWidth: 420, margin: '2rem auto' }}>
      <h2>Connexion</h2>
      {error && (
        <p style={{ background: 'var(--danger-bg)', color: 'var(--danger)', padding: '.5rem .75rem', borderRadius: 6 }}>
          {error}
        </p>
      )}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
        <div className="field">
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </div>
        <div className="field">
          <label>Mot de passe</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !email || !password}>
          {busy ? <span className="spin" /> : null}Se connecter
        </button>
      </form>
    </section>
  );
}

function ExecuteModal({
  campaign,
  onCancel,
  onConfirm,
}: {
  campaign: Campaign;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Confirmer l’exécution</h3>
        <p>
          Tu vas générer une charge HTTP bornée de <b>{campaign.maxRps} rps</b> ({campaign.concurrency}{' '}
          en parallèle) pendant <b>{campaign.maxDurationSec}s</b> vers{' '}
          <span className="modal-target">{campaign.target}</span>. Le kill switch reste disponible
          pendant l’exécution.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={onCancel}>Annuler</button>
          <button className="btn btn-primary" onClick={onConfirm}>Lancer la campagne</button>
        </div>
      </div>
    </div>
  );
}

function ApproveModal({
  campaign,
  authRequired,
  identityEmail,
  onCancel,
  onDecide,
}: {
  campaign: Campaign;
  authRequired: boolean;
  identityEmail: string;
  onCancel: () => void;
  onDecide: (c: Campaign, approvedBy: string, decision: 'APPROVED' | 'REJECTED', reason: string) => void;
}) {
  const [approver, setApprover] = useState(identityEmail);
  const [reason, setReason] = useState('');
  // En mode auth, l'approbateur EST l'utilisateur connecté (non modifiable).
  const effectiveApprover = authRequired ? identityEmail : approver;
  const sameAsAuthor = effectiveApprover.trim() !== '' && effectiveApprover.trim() === campaign.createdBy;

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Approbation — {campaign.name}</h3>
        <p>Séparation des rôles : l’approbateur doit être différent de l’auteur ({campaign.createdBy}).</p>
        {authRequired ? (
          <p className="hint">
            Approbateur : <b>{identityEmail}</b>
          </p>
        ) : (
          <div className="field" style={{ marginBottom: '.75rem' }}>
            <label>Approbateur (Security Officer)</label>
            <input className={sameAsAuthor ? 'invalid' : ''} value={approver} onChange={(e) => setApprover(e.target.value)} />
            {sameAsAuthor && <span className="hint" style={{ color: 'var(--danger)' }}>Doit différer de l’auteur.</span>}
          </div>
        )}
        <div className="field">
          <label>Motif (requis pour un rejet)</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="btn-row">
          <button className="btn" onClick={onCancel}>Annuler</button>
          <button
            className="btn btn-danger"
            disabled={sameAsAuthor || !reason.trim()}
            onClick={() => onDecide(campaign, effectiveApprover.trim(), 'REJECTED', reason)}
          >
            Rejeter
          </button>
          <button
            className="btn btn-primary"
            disabled={sameAsAuthor || (!authRequired && !approver.trim())}
            onClick={() => onDecide(campaign, effectiveApprover.trim(), 'APPROVED', reason)}
          >
            Approuver
          </button>
        </div>
      </div>
    </div>
  );
}
