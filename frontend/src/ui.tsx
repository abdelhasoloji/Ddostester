import { useEffect, useState } from 'react';
import { reportUrl, streamUrl } from './api.js';
import type { Campaign, CampaignStatus, WrsBreakdown, LiveProgressData } from './api.js';
import { useApp, canDo } from './context.js';

const HARD_CAPS = { maxRps: 2000, concurrency: 500, maxDurationSec: 900 };

const badgeLabel: Record<CampaignStatus, string> = {
  PENDING_APPROVAL: 'En attente',
  APPROVED: 'Approuvée',
  REJECTED: 'Rejetée',
  RUNNING: 'En cours',
  COMPLETED: 'Terminée',
  KILLED_AUTO: 'Kill auto',
  KILLED_MANUAL: 'Kill manuel',
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
        <span className="hint">Démarrage de l’exécution…</span>
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
        <span>{p.sent} requêtes</span>
        <span>{p.actualRps} rps</span>
        <span>
          {p.successful} ok · {p.failed} échec
        </span>
      </div>
    </div>
  );
}

export function CampaignCard({ c }: { c: Campaign }) {
  const app = useApp();
  const run = app.runs[c.id];
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
              Approuver / Rejeter
            </button>
          )}
          {c.status === 'APPROVED' && canDo(role, 'execute', ar) && (
            <button
              className="btn btn-sm btn-primary"
              disabled={isBusy}
              onClick={() => app.setConfirmExec(c)}
            >
              {isBusy ? <span className="spin" /> : null}Exécuter
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
              Rapport ↗
            </a>
          )}
          {(run || c.runId) && (
            <button className="btn btn-sm btn-ghost" onClick={() => app.toggleDetails(c)}>
              {app.expanded === c.id ? 'Masquer' : 'Détails'}
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
          {c.scenario && c.scenario.length > 1 ? ` · scénario ${c.scenario.length} phases` : ''}
        </span>
        <span>
          par {c.createdBy}
          {c.approvedBy ? ` · appr. ${c.approvedBy}` : ''}
        </span>
        {c.scheduledAt && (
          <span title="Exécution planifiée">🕒 {new Date(c.scheduledAt).toLocaleString()}</span>
        )}
      </div>

      {c.status === 'RUNNING' && <LiveProgress campaignId={c.id} />}

      {app.expanded === c.id && run && (
        <div className="details">
          <div className="metrics">
            <div className="metric">
              <div className="k">Requêtes</div>
              <div className="v">{run.generator.totalRequests}</div>
            </div>
            <div className="metric">
              <div className="k">Succès / échecs</div>
              <div className="v">
                {run.generator.successful} / {run.generator.failed}
              </div>
            </div>
            <div className="metric">
              <div className="k">RPS réel</div>
              <div className="v">{run.generator.actualRps}</div>
            </div>
            <div className="metric">
              <div className="k">Latence p95</div>
              <div className="v">{run.generator.latencyMs.p95} ms</div>
            </div>
            <div className="metric">
              <div className="k">Sonde 5xx</div>
              <div className="v">{run.probe.errorRate5xx}%</div>
            </div>
            <div className="metric">
              <div className="k">Dispo sonde</div>
              <div className="v">
                {run.probe.available}/{run.probe.samples}
              </div>
            </div>
          </div>
          <div className="wrs-breakdown">
            <span>
              Détection{run.wrs.estimated ? ' (est.)' : ''} <b>{run.wrs.detection}</b>
            </span>
            <span>
              Mitigation{run.wrs.estimated ? ' (est.)' : ''} <b>{run.wrs.mitigation}</b>
            </span>
            <span>
              Disponibilité <b>{run.wrs.availability}</b>
            </span>
            <span>
              Collatéral <b>{run.wrs.collateral}</b>
            </span>
          </div>
          {run.wrs.estimated && (
            <p className="hint" style={{ marginTop: '.5rem' }}>
              Détection et Mitigation sont <b>estimées</b> (pas d’intégration protection) :
              constantes, le WRS reflète surtout la disponibilité mesurée.
            </p>
          )}
        </div>
      )}
      {app.expanded === c.id && !run && (
        <div className="details">
          <span className="hint">Aucune métrique détaillée disponible.</span>
        </div>
      )}
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
      <h2>Nouvelle campagne</h2>
      <form className="grid" onSubmit={submit}>
        <div className="field">
          <label>Nom</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div className="field">
          <label>Vecteur</label>
          <select
            value={form.vector}
            onChange={(e) => setForm({ ...form, vector: e.target.value })}
          >
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
        <div className="field">
          <label>Profil de charge</label>
          <select
            value={form.profile}
            onChange={(e) => setForm({ ...form, profile: e.target.value })}
          >
            <option value="constant">Constant</option>
            <option value="ramp">Montée progressive (25→50→100 %)</option>
            <option value="wave">Vagues (100→20→100 %)</option>
          </select>
        </div>
        <div className="field">
          <label>Planifier (optionnel)</label>
          <input
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
          />
          <span className="hint">exécution auto une fois approuvée</span>
        </div>
        {form.vector === 'http-post' && (
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Corps de la requête (POST)</label>
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
            J’atteste que la cible m’appartient ou que je dispose d’un <b>mandat écrit</b> pour la
            tester (interne WEDOS / périmètre autorisé).
          </span>
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={!formValid}>
          Soumettre pour approbation
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
        <h3>Confirmer l’exécution</h3>
        <p>
          Tu vas générer une charge HTTP bornée de <b>{c.maxRps} rps</b> ({c.concurrency} en
          parallèle) pendant <b>{c.maxDurationSec}s</b> vers{' '}
          <span className="modal-target">{c.target}</span>. Le kill switch reste disponible.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => app.setConfirmExec(null)}>
            Annuler
          </button>
          <button className="btn btn-primary" onClick={() => app.execute(c)}>
            Lancer la campagne
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
        <h3>Approbation — {c.name}</h3>
        <p>Séparation des rôles : l’approbateur doit être différent de l’auteur ({c.createdBy}).</p>
        {app.authRequired ? (
          <p className="hint">
            Approbateur : <b>{app.identity?.email}</b>
          </p>
        ) : (
          <div className="field" style={{ marginBottom: '.75rem' }}>
            <label>Approbateur (Security Officer)</label>
            <input
              className={sameAsAuthor ? 'invalid' : ''}
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
            />
            {sameAsAuthor && (
              <span className="hint" style={{ color: 'var(--danger)' }}>
                Doit différer de l’auteur.
              </span>
            )}
          </div>
        )}
        <div className="field">
          <label>Motif (requis pour un rejet)</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => app.setApproveFor(null)}>
            Annuler
          </button>
          <button
            className="btn btn-danger"
            disabled={sameAsAuthor || !reason.trim()}
            onClick={() => app.approve(c, effective.trim(), 'REJECTED', reason)}
          >
            Rejeter
          </button>
          <button
            className="btn btn-primary"
            disabled={sameAsAuthor || (!app.authRequired && !approver.trim())}
            onClick={() => app.approve(c, effective.trim(), 'APPROVED', reason)}
          >
            Approuver
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
      <h2>Connexion</h2>
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
