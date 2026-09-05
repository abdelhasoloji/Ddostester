import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { createStore } from './store/index.js';
import { kills } from './runtime/kills.js';
import {
  createCampaign,
  approveCampaign,
  assertExecutable,
  transition,
  CampaignError,
} from './modules/campaigns/service.js';
import { executeCampaign } from './modules/campaigns/runner.js';
import { dueCampaigns } from './modules/campaigns/scheduler.js';
import type { Campaign } from './modules/campaigns/model.js';
import { KillSwitch } from './modules/probe/probe.js';
import { renderCampaignReportHtml } from './modules/reports/report.js';
import { renderMetrics } from './modules/metrics/prometheus.js';
import { renderComplianceHtml } from './modules/reports/compliance.js';
import { buildWrsHistory } from './modules/wrs/history.js';
import type { CampaignInput } from './modules/campaigns/model.js';
import { initAuth, login, identityFromRequest } from './auth/guard.js';
import { can } from './auth/rbac.js';
import type { Permission } from './auth/rbac.js';

const PORT = Number(process.env.PORT ?? 8080);
// Adresse d'écoute. Défaut : loopback uniquement — l'outil ne doit JAMAIS être
// exposé publiquement (pas d'auth). Pour un accès distant, passer par un tunnel
// SSH plutôt que binder sur 0.0.0.0.
const HOST = process.env.HOST ?? '127.0.0.1';
const ALLOWED_TARGETS = (process.env.ALLOWED_TARGETS ?? 'localhost,127.0.0.1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const store = await createStore();
const auth = initAuth();

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

/**
 * Garde de permission. Si l'auth est désactivée (mode dev, pas de secret),
 * laisse passer. Sinon exige un token valide et le droit correspondant, et
 * attache l'identité à la requête.
 */
function guard(perm: Permission) {
  return async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!auth.enabled) return;
    const id = identityFromRequest(auth, req);
    if (!id) return reply.code(401).send({ error: 'authentification requise' });
    req.authUser = id;
    if (!can(id.role, perm)) return reply.code(403).send({ error: `droit ${perm} manquant` });
  };
}

// Sert l'UI React buildée (frontend/dist) sur la même origine que l'API : un
// seul service, un seul tunnel SSH. Ignoré si le build front est absent.
const frontendDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'dist');
if (existsSync(frontendDist)) {
  await app.register(fastifyStatic, { root: frontendDist });
  app.log.info(`UI servie depuis ${frontendDist}`);
}

function fail(err: unknown, reply: import('fastify').FastifyReply) {
  if (err instanceof CampaignError) return reply.code(400).send({ error: err.message });
  app.log.error(err);
  return reply.code(500).send({ error: 'erreur interne' });
}

/** Enregistre une entrée d'audit (best-effort, ne bloque pas la réponse). */
async function auditAs(
  actor: string,
  action: import('./modules/audit/model.js').AuditEntry['action'],
  campaignId?: string,
  detail?: string,
) {
  try {
    await store.saveAudit({ id: randomUUID(), at: new Date().toISOString(), actor, action, campaignId, detail });
  } catch (err) {
    app.log.error({ err }, 'échec écriture audit');
  }
}
const audit = (
  req: import('fastify').FastifyRequest,
  action: import('./modules/audit/model.js').AuditEntry['action'],
  campaignId?: string,
  detail?: string,
) => auditAs(req.authUser?.email ?? 'dev', action, campaignId, detail);

/**
 * Cœur d'exécution partagé (route manuelle + ordonnanceur). Gère le kill switch,
 * les transitions de statut, la persistance du run et l'audit.
 */
async function runCampaign(c: Campaign, actor: string): Promise<import('./modules/campaigns/runner.js').CampaignRun> {
  const kill = new KillSwitch();
  kills.set(c.id, kill);
  await store.saveCampaign(transition(c, 'RUNNING'));
  try {
    const run = await executeCampaign(c, ALLOWED_TARGETS, kill);
    await store.saveRun(run);
    await store.saveCampaign({ ...c, status: run.status, wrs: run.wrs, runId: run.runId });
    await auditAs(actor, 'campaign.execute', c.id, `${run.status} · WRS ${run.wrs.wrs} (${run.wrs.level})`);
    return run;
  } catch (err) {
    await store.saveCampaign(transition(c, 'APPROVED'));
    throw err;
  } finally {
    kills.clear(c.id);
  }
}

app.get('/health', async () => ({
  status: 'ok',
  allowedTargets: ALLOWED_TARGETS,
  storage: store.backend,
  authRequired: auth.enabled,
}));

// --- Auth -------------------------------------------------------------------
app.post('/api/auth/login', async (req, reply) => {
  if (!auth.enabled) return reply.code(400).send({ error: 'authentification désactivée' });
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) return reply.code(400).send({ error: 'email et mot de passe requis' });
  const res = login(auth, email, password);
  if (!res) return reply.code(401).send({ error: 'identifiants invalides' });
  return res;
});

app.get('/api/auth/me', { preHandler: guard('campaign:read') }, async (req) => {
  return req.authUser ?? { email: null, role: null, authRequired: false };
});

// --- CAM : gestion des campagnes -------------------------------------------
app.get('/api/campaigns', { preHandler: guard('campaign:read') }, async () => store.listCampaigns());

app.get('/api/campaigns/:id', { preHandler: guard('campaign:read') }, async (req, reply) => {
  const c = await store.getCampaign((req.params as { id: string }).id);
  return c ?? reply.code(404).send({ error: 'campagne introuvable' });
});

app.post('/api/campaigns', { preHandler: guard('campaign:create') }, async (req, reply) => {
  try {
    const input = req.body as CampaignInput;
    // En mode auth, l'auteur est l'utilisateur authentifié (pas le corps).
    if (req.authUser) input.createdBy = req.authUser.email;
    const campaign = createCampaign(input, ALLOWED_TARGETS);
    await store.saveCampaign(campaign);
    await audit(req, 'campaign.create', campaign.id, `${campaign.name} → ${campaign.target}`);
    return reply.code(201).send(campaign);
  } catch (err) {
    return fail(err, reply);
  }
});

app.post('/api/campaigns/:id/approval', { preHandler: guard('campaign:approve') }, async (req, reply) => {
  try {
    const c = await store.getCampaign((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: 'campagne introuvable' });
    const body = req.body as { approvedBy?: string; decision: 'APPROVED' | 'REJECTED'; reason?: string };
    // En mode auth, l'approbateur est l'utilisateur authentifié.
    const approvedBy = req.authUser?.email ?? body.approvedBy ?? '';
    const updated = approveCampaign(c, approvedBy, body.decision, body.reason);
    await store.saveCampaign(updated);
    await audit(
      req,
      body.decision === 'APPROVED' ? 'campaign.approve' : 'campaign.reject',
      c.id,
      body.reason,
    );
    return updated;
  } catch (err) {
    return fail(err, reply);
  }
});

// --- Exécution + kill switch manuel ----------------------------------------
app.post('/api/campaigns/:id/execute', { preHandler: guard('campaign:execute') }, async (req, reply) => {
  const c = await store.getCampaign((req.params as { id: string }).id);
  if (!c) return reply.code(404).send({ error: 'campagne introuvable' });
  try {
    assertExecutable(c);
  } catch (err) {
    return fail(err, reply);
  }

  try {
    const run = await runCampaign(c, req.authUser?.email ?? 'dev');
    return reply.code(201).send(run);
  } catch (err) {
    return fail(err, reply);
  }
});

// Kill switch niveau 2 : arrêt manuel (SOC/NOC).
app.post('/api/campaigns/:id/kill', { preHandler: guard('campaign:kill') }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const kill = kills.get(id);
  if (!kill) return reply.code(404).send({ error: 'aucune exécution en cours' });
  kill.trigger('KILLED_MANUAL');
  await audit(req, 'campaign.kill', id);
  return { status: 'KILLED_MANUAL' };
});

// --- Historique WRS + régressions (TSD §5.4 WRS-03) -------------------------
app.get('/api/wrs/history', { preHandler: guard('campaign:read') }, async () => {
  const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
  return buildWrsHistory(campaigns, runs);
});

// --- Monitoring : métriques Prometheus (loopback, agrégats non sensibles) ---
app.get('/metrics', async (_req, reply) => {
  const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
  return reply.type('text/plain; version=0.0.4').send(renderMetrics(campaigns, runs.length));
});

// --- Audit ------------------------------------------------------------------
app.get('/api/audit', { preHandler: guard('campaign:read') }, async (req) => {
  const { limit } = req.query as { limit?: string };
  return store.listAudit(limit ? Number(limit) : 200);
});

// --- RPT : runs & rapport ---------------------------------------------------
app.get('/api/runs', { preHandler: guard('campaign:read') }, async (req) => {
  const { campaignId } = req.query as { campaignId?: string };
  return store.listRuns(campaignId);
});

app.get('/api/runs/:runId', { preHandler: guard('campaign:read') }, async (req, reply) => {
  const r = await store.getRun((req.params as { runId: string }).runId);
  return r ?? reply.code(404).send({ error: 'run introuvable' });
});

// Rapport de conformité agrégé (DORA/NIS2). Token en query pour lien navigateur.
app.get('/api/reports/compliance', async (req, reply) => {
  if (auth.enabled) {
    const { token } = req.query as { token?: string };
    const id = token
      ? identityFromRequest(auth, { headers: { authorization: `Bearer ${token}` } } as import('fastify').FastifyRequest)
      : identityFromRequest(auth, req);
    if (!id) return reply.code(401).send({ error: 'authentification requise' });
    if (!can(id.role, 'campaign:read')) return reply.code(403).send({ error: 'droit manquant' });
  }
  const { from, to } = req.query as { from?: string; to?: string };
  const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
  return reply.type('text/html').send(renderComplianceHtml(campaigns, runs, { from, to }));
});

app.get('/api/runs/:runId/report', async (req, reply) => {
  // Le rapport s'ouvre dans un onglet (pas d'en-tête Authorization) : en mode
  // auth, on accepte le token en query (?token=) pour ce lien navigateur.
  if (auth.enabled) {
    const { token } = req.query as { token?: string };
    const id = token ? identityFromRequest(auth, { headers: { authorization: `Bearer ${token}` } } as import('fastify').FastifyRequest) : null;
    if (!id) return reply.code(401).send({ error: 'authentification requise' });
    if (!can(id.role, 'campaign:read')) return reply.code(403).send({ error: 'droit manquant' });
  }
  const r = await store.getRun((req.params as { runId: string }).runId);
  if (!r) return reply.code(404).send({ error: 'run introuvable' });
  const c = await store.getCampaign(r.campaignId);
  if (!c) return reply.code(404).send({ error: 'campagne introuvable' });
  return reply.type('text/html').send(renderCampaignReportHtml(c, r));
});

// --- Ordonnanceur (CAM-01) : exécute les campagnes planifiées échues ---------
// Remplace Celery/Redis du TSD par une boucle in-process simple.
const SCHEDULER = (process.env.SCHEDULER ?? 'on') !== 'off';
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000);
if (SCHEDULER) {
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const campaigns = await store.listCampaigns();
      for (const c of dueCampaigns(campaigns, Date.now())) {
        if (kills.get(c.id)) continue; // déjà en cours
        app.log.info(`ordonnanceur : exécution planifiée de ${c.id}`);
        try {
          await runCampaign(c, 'scheduler');
        } catch (err) {
          app.log.error({ err }, `échec exécution planifiée ${c.id}`);
        }
      }
    } catch (err) {
      app.log.error({ err }, 'échec tick ordonnanceur');
    } finally {
      ticking = false;
    }
  }, SCHEDULER_INTERVAL_MS).unref();
}

app
  .listen({ port: PORT, host: HOST })
  .then((addr) =>
    app.log.info(
      `ShieldTest control plane sur ${addr} — stockage: ${store.backend} — ordonnanceur: ${SCHEDULER ? 'on' : 'off'} — cibles: ${ALLOWED_TARGETS.join(', ')}`,
    ),
  )
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
