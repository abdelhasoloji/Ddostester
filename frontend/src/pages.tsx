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

// ---------- barre latérale + gabarit ----------
const NAV = [
  { to: '/', label: 'Vue d’ensemble', icon: '▚', end: true },
  { to: '/campagnes', label: 'Campagnes', icon: '◇', end: false },
  { to: '/rapports', label: 'Rapports', icon: '▤', end: false },
  { to: '/audit', label: 'Journal d’audit', icon: '☰', end: false },
  { to: '/parametres', label: 'Paramètres', icon: '⚙', end: false },
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
                  Déconnexion
                </button>
              </>
            ) : (
              <span className="hint">
                Mode dev · opérateur <b>{app.operator || '—'}</b>
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

// ---------- Vue d'ensemble ----------
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
        title="Vue d’ensemble"
        sub={
          <>
            Cibles autorisées : <code>{app.allowed.join(', ') || '—'}</code>
            {app.agentName && (
              <>
                {' '}
                · agent <code>{app.agentName}</code>
              </>
            )}{' '}
            · générateur HTTP borné (aucun vecteur volumétrique).
          </>
        }
      />

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-v">{c.length}</div>
          <div className="kpi-k">Campagnes</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{running}</div>
          <div className="kpi-k">En cours</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{pending}</div>
          <div className="kpi-k">En attente</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{completed}</div>
          <div className="kpi-k">Terminées</div>
        </div>
        <div className="kpi">
          <div className="kpi-v">{avgWrs ?? '—'}</div>
          <div className="kpi-k">WRS moyen</div>
        </div>
      </div>

      <h2 className="section-title">Historique WRS par cible</h2>
      {app.wrsSeries.length === 0 ? (
        <div className="empty">Aucune exécution notée pour l’instant.</div>
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
      )}
    </>
  );
}

// ---------- Campagnes ----------
export function CampaignsPage() {
  const app = useApp();
  return (
    <>
      <PageHead
        title="Campagnes"
        sub={app.anyRunning ? 'Actualisation automatique en cours…' : undefined}
      />
      <NewCampaignForm />
      <h2 className="section-title">Liste des campagnes</h2>
      <div className="campaigns">
        {app.campaigns.length === 0 && <div className="empty">Aucune campagne pour l’instant.</div>}
        {app.campaigns.map((c) => (
          <CampaignCard key={c.id} c={c} />
        ))}
      </div>
    </>
  );
}

// ---------- Rapports ----------
export function ReportsPage() {
  const app = useApp();
  const withRun = app.campaigns.filter((c) => c.runId);
  return (
    <>
      <PageHead
        title="Rapports"
        sub="Rapports de campagne (HTML/PDF) et conformité agrégée DORA / NIS2."
      />
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Conformité agrégée</h2>
        <p className="hint">
          Synthèse de toutes les campagnes exécutées, alignée sur les exigences de résilience
          opérationnelle (DORA) et de gestion des risques (NIS2).
        </p>
        <a className="btn btn-primary" href={complianceUrl()} target="_blank" rel="noreferrer">
          Ouvrir le rapport de conformité ↗
        </a>
      </div>

      <h2 className="section-title">Rapports de campagne</h2>
      {withRun.length === 0 ? (
        <div className="empty">Aucune campagne exécutée — pas encore de rapport.</div>
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
                Rapport ↗
              </a>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- Journal d'audit ----------
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
        title="Journal d’audit"
        sub="Trace immuable des actions (création, approbation, exécution, kill switch)."
      />
      <div className="page-actions">
        <button className="btn btn-sm" onClick={app.loadAudit}>
          Rafraîchir
        </button>
      </div>
      <div className="card">
        {rows === null && <span className="hint">Chargement…</span>}
        {rows !== null && rows.length === 0 && <span className="hint">Aucune entrée.</span>}
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

// ---------- Paramètres ----------
export function SettingsPage() {
  const app = useApp();
  return (
    <>
      <PageHead
        title="Paramètres"
        sub="Configuration du control plane (lecture seule côté client)."
      />
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Session</h2>
        {app.authRequired && app.identity ? (
          <div className="kv">
            <div>
              <span className="k">Utilisateur</span>
              <span className="v">{app.identity.email}</span>
            </div>
            <div>
              <span className="k">Rôle</span>
              <span className="v">{roleLabel[app.identity.role]}</span>
            </div>
          </div>
        ) : (
          <div className="field" style={{ maxWidth: 360 }}>
            <label htmlFor="op">Opérateur (mode dev)</label>
            <input
              id="op"
              placeholder="prenom.nom@wedos"
              value={app.operator}
              onChange={(e) => app.setOperator(e.target.value)}
            />
            <span className="hint">
              Utilisé comme auteur/approbateur tant que l’authentification n’est pas activée.
            </span>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Moteur & sécurité</h2>
        <div className="kv">
          <div>
            <span className="k">Agent actif</span>
            <span className="v">
              <code>{app.agentName || 'builtin-http'}</code>
            </span>
          </div>
          <div>
            <span className="k">Authentification</span>
            <span className="v">
              {app.authRequired ? 'JWT / RBAC activé' : 'Mode dev (désactivée)'}
            </span>
          </div>
          <div>
            <span className="k">Cibles autorisées</span>
            <span className="v">
              <code>{app.allowed.join(', ') || '—'}</code>
            </span>
          </div>
        </div>
        <p className="hint" style={{ marginTop: '.75rem' }}>
          Générateur HTTP borné uniquement (GET/POST, plafonné, liste blanche). Aucun vecteur
          volumétrique ou d’épuisement n’est implémenté. La liste blanche et l’agent se configurent
          côté serveur (variables d’environnement).
        </p>
      </div>
    </>
  );
}
