import { existsSync } from 'node:fs';
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
import { KillSwitch } from './modules/probe/probe.js';
import { renderCampaignReportHtml } from './modules/reports/report.js';
import type { CampaignInput } from './modules/campaigns/model.js';

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

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

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

app.get('/health', async () => ({
  status: 'ok',
  allowedTargets: ALLOWED_TARGETS,
  storage: store.backend,
}));

// --- CAM : gestion des campagnes -------------------------------------------
app.get('/api/campaigns', async () => store.listCampaigns());

app.get('/api/campaigns/:id', async (req, reply) => {
  const c = await store.getCampaign((req.params as { id: string }).id);
  return c ?? reply.code(404).send({ error: 'campagne introuvable' });
});

app.post('/api/campaigns', async (req, reply) => {
  try {
    const campaign = createCampaign(req.body as CampaignInput, ALLOWED_TARGETS);
    await store.saveCampaign(campaign);
    return reply.code(201).send(campaign);
  } catch (err) {
    return fail(err, reply);
  }
});

app.post('/api/campaigns/:id/approval', async (req, reply) => {
  try {
    const c = await store.getCampaign((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: 'campagne introuvable' });
    const { approvedBy, decision, reason } = req.body as {
      approvedBy: string;
      decision: 'APPROVED' | 'REJECTED';
      reason?: string;
    };
    const updated = approveCampaign(c, approvedBy, decision, reason);
    await store.saveCampaign(updated);
    return updated;
  } catch (err) {
    return fail(err, reply);
  }
});

// --- Exécution + kill switch manuel ----------------------------------------
app.post('/api/campaigns/:id/execute', async (req, reply) => {
  const c = await store.getCampaign((req.params as { id: string }).id);
  if (!c) return reply.code(404).send({ error: 'campagne introuvable' });
  try {
    assertExecutable(c);
  } catch (err) {
    return fail(err, reply);
  }

  const kill = new KillSwitch();
  kills.set(c.id, kill);
  await store.saveCampaign(transition(c, 'RUNNING'));
  try {
    const run = await executeCampaign(c, ALLOWED_TARGETS, kill);
    await store.saveRun(run);
    await store.saveCampaign({ ...c, status: run.status, wrs: run.wrs, runId: run.runId });
    return reply.code(201).send(run);
  } catch (err) {
    await store.saveCampaign(transition(c, 'APPROVED'));
    return fail(err, reply);
  } finally {
    kills.clear(c.id);
  }
});

// Kill switch niveau 2 : arrêt manuel (SOC/NOC).
app.post('/api/campaigns/:id/kill', async (req, reply) => {
  const kill = kills.get((req.params as { id: string }).id);
  if (!kill) return reply.code(404).send({ error: 'aucune exécution en cours' });
  kill.trigger('KILLED_MANUAL');
  return { status: 'KILLED_MANUAL' };
});

// --- RPT : runs & rapport ---------------------------------------------------
app.get('/api/runs', async (req) => {
  const { campaignId } = req.query as { campaignId?: string };
  return store.listRuns(campaignId);
});

app.get('/api/runs/:runId', async (req, reply) => {
  const r = await store.getRun((req.params as { runId: string }).runId);
  return r ?? reply.code(404).send({ error: 'run introuvable' });
});

app.get('/api/runs/:runId/report', async (req, reply) => {
  const r = await store.getRun((req.params as { runId: string }).runId);
  if (!r) return reply.code(404).send({ error: 'run introuvable' });
  const c = await store.getCampaign(r.campaignId);
  if (!c) return reply.code(404).send({ error: 'campagne introuvable' });
  return reply.type('text/html').send(renderCampaignReportHtml(c, r));
});

app
  .listen({ port: PORT, host: HOST })
  .then((addr) =>
    app.log.info(
      `ShieldTest control plane sur ${addr} — stockage: ${store.backend} — cibles: ${ALLOWED_TARGETS.join(', ')}`,
    ),
  )
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
