import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Store } from './store/index.js';
import type { AuthState } from './auth/guard.js';
import { kills } from './runtime/kills.js';
import { liveProgress } from './runtime/live.js';
import {
  createCampaign,
  approveCampaign,
  assertExecutable,
  transition,
  CampaignError,
} from './modules/campaigns/service.js';
import { executeCampaign } from './modules/campaigns/runner.js';
import type { CampaignRun } from './modules/campaigns/runner.js';
import type { Campaign, CampaignInput } from './modules/campaigns/model.js';
import { KillSwitch } from './modules/probe/probe.js';
import { renderCampaignReportHtml } from './modules/reports/report.js';
import { renderMetrics } from './modules/metrics/prometheus.js';
import { renderComplianceHtml } from './modules/reports/compliance.js';
import { buildWrsHistory } from './modules/wrs/history.js';
import type { AuditEntry } from './modules/audit/model.js';
import type { LoadProgress } from './engine/loadTest.js';
import { login, identityFromRequest } from './auth/guard.js';
import { can } from './auth/rbac.js';
import type { Permission } from './auth/rbac.js';

export interface BuildOptions {
  store: Store;
  auth: AuthState;
  allowedTargets: string[];
  logger?: boolean;
  serveStatic?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  runCampaign: (c: Campaign, actor: string) => Promise<CampaignRun>;
}

/** Construit l'app Fastify (routes + logique) sans démarrer l'écoute. */
export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { store, auth, allowedTargets } = opts;

  const app = Fastify({
    logger: opts.logger === false
      ? false
      : {
          // Ne jamais logguer les tokens passés en query (?token=) ni l'en-tête Authorization.
          serializers: {
            req(req) {
              return {
                method: req.method,
                url: String(req.url).replace(/([?&]token=)[^&]+/g, '$1REDACTED'),
                hostname: req.hostname,
                remoteAddress: req.ip,
              };
            },
          },
          redact: ['req.headers.authorization'],
        },
  });
  await app.register(cors, { origin: true });

  function guard(perm: Permission) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!auth.enabled) return;
      const id = identityFromRequest(auth, req);
      if (!id) return reply.code(401).send({ error: 'authentification requise' });
      req.authUser = id;
      if (!can(id.role, perm)) return reply.code(403).send({ error: `droit ${perm} manquant` });
    };
  }

  /** Vérifie un token de lecture passé en query (liens navigateur : rapport, SSE). */
  function readTokenAllowed(req: FastifyRequest): boolean {
    if (!auth.enabled) return true;
    const { token } = req.query as { token?: string };
    const id = token
      ? identityFromRequest(auth, { headers: { authorization: `Bearer ${token}` } } as FastifyRequest)
      : identityFromRequest(auth, req);
    return id !== null && can(id.role, 'campaign:read');
  }

  if (opts.serveStatic !== false) {
    const frontendDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'dist');
    if (existsSync(frontendDist)) {
      await app.register(fastifyStatic, { root: frontendDist });
      app.log.info(`UI servie depuis ${frontendDist}`);
    }
  }

  function fail(err: unknown, reply: FastifyReply) {
    if (err instanceof CampaignError) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'erreur interne' });
  }

  async function auditAs(actor: string, action: AuditEntry['action'], campaignId?: string, detail?: string) {
    try {
      await store.saveAudit({ id: randomUUID(), at: new Date().toISOString(), actor, action, campaignId, detail });
    } catch (err) {
      app.log.error({ err }, 'échec écriture audit');
    }
  }
  const audit = (req: FastifyRequest, action: AuditEntry['action'], campaignId?: string, detail?: string) =>
    auditAs(req.authUser?.email ?? 'dev', action, campaignId, detail);

  async function runCampaign(c: Campaign, actor: string): Promise<CampaignRun> {
    const kill = new KillSwitch();
    kills.set(c.id, kill);
    await store.saveCampaign(transition(c, 'RUNNING'));
    const onProgress = (p: LoadProgress) =>
      liveProgress.set(c.id, { ...p, maxDurationSec: c.maxDurationSec, status: 'RUNNING' });
    try {
      const run = await executeCampaign(c, allowedTargets, kill, onProgress);
      await store.saveRun(run);
      await store.saveCampaign({ ...c, status: run.status, wrs: run.wrs, runId: run.runId });
      await auditAs(actor, 'campaign.execute', c.id, `${run.status} · WRS ${run.wrs.wrs} (${run.wrs.level})`);
      return run;
    } catch (err) {
      await store.saveCampaign(transition(c, 'APPROVED'));
      throw err;
    } finally {
      liveProgress.clear(c.id);
      kills.clear(c.id);
    }
  }

  app.get('/health', async () => ({
    status: 'ok',
    allowedTargets,
    storage: store.backend,
    authRequired: auth.enabled,
  }));

  // Anti-brute-force : verrou temporaire après plusieurs échecs (par email+IP).
  const loginFails = new Map<string, { count: number; until: number }>();
  const MAX_FAILS = 5;
  const LOCK_MS = 60_000;

  app.post('/api/auth/login', async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentification désactivée' });
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) return reply.code(400).send({ error: 'email et mot de passe requis' });
    const key = `${email.toLowerCase()}|${req.ip}`;
    const entry = loginFails.get(key);
    if (entry && entry.count >= MAX_FAILS && Date.now() < entry.until) {
      return reply.code(429).send({ error: 'trop de tentatives — réessaie plus tard' });
    }
    const res = login(auth, email, password);
    if (!res) {
      loginFails.set(key, { count: (entry?.count ?? 0) + 1, until: Date.now() + LOCK_MS });
      return reply.code(401).send({ error: 'identifiants invalides' });
    }
    loginFails.delete(key);
    return res;
  });

  app.get('/api/auth/me', { preHandler: guard('campaign:read') }, async (req) => {
    return req.authUser ?? { email: null, role: null, authRequired: false };
  });

  app.get('/api/campaigns', { preHandler: guard('campaign:read') }, async () => store.listCampaigns());

  app.get('/api/campaigns/:id', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const c = await store.getCampaign((req.params as { id: string }).id);
    return c ?? reply.code(404).send({ error: 'campagne introuvable' });
  });

  app.post('/api/campaigns', { preHandler: guard('campaign:create') }, async (req, reply) => {
    try {
      const input = req.body as CampaignInput;
      if (req.authUser) input.createdBy = req.authUser.email;
      const campaign = createCampaign(input, allowedTargets);
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
      const approvedBy = req.authUser?.email ?? body.approvedBy ?? '';
      const updated = approveCampaign(c, approvedBy, body.decision, body.reason);
      await store.saveCampaign(updated);
      await audit(req, body.decision === 'APPROVED' ? 'campaign.approve' : 'campaign.reject', c.id, body.reason);
      return updated;
    } catch (err) {
      return fail(err, reply);
    }
  });

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

  app.get('/api/campaigns/:id/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentification requise' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send(liveProgress.get(id) ?? { status: 'idle' });
    const timer = setInterval(() => {
      const p = liveProgress.get(id);
      if (p) send(p);
      else {
        send({ status: 'done' });
        clearInterval(timer);
        res.end();
      }
    }, 1000);
    req.raw.on('close', () => clearInterval(timer));
  });

  app.post('/api/campaigns/:id/kill', { preHandler: guard('campaign:kill') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const kill = kills.get(id);
    if (!kill) return reply.code(404).send({ error: 'aucune exécution en cours' });
    kill.trigger('KILLED_MANUAL');
    await audit(req, 'campaign.kill', id);
    return { status: 'KILLED_MANUAL' };
  });

  app.get('/api/wrs/history', { preHandler: guard('campaign:read') }, async () => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return buildWrsHistory(campaigns, runs);
  });

  app.get('/metrics', async (_req, reply) => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return reply.type('text/plain; version=0.0.4').send(renderMetrics(campaigns, runs.length));
  });

  app.get('/api/audit', { preHandler: guard('campaign:read') }, async (req) => {
    const { limit } = req.query as { limit?: string };
    return store.listAudit(limit ? Number(limit) : 200);
  });

  app.get('/api/runs', { preHandler: guard('campaign:read') }, async (req) => {
    const { campaignId } = req.query as { campaignId?: string };
    return store.listRuns(campaignId);
  });

  app.get('/api/runs/:runId', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const r = await store.getRun((req.params as { runId: string }).runId);
    return r ?? reply.code(404).send({ error: 'run introuvable' });
  });

  app.get('/api/reports/compliance', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentification requise' });
    const { from, to } = req.query as { from?: string; to?: string };
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return reply.type('text/html').send(renderComplianceHtml(campaigns, runs, { from, to }));
  });

  app.get('/api/runs/:runId/report', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentification requise' });
    const r = await store.getRun((req.params as { runId: string }).runId);
    if (!r) return reply.code(404).send({ error: 'run introuvable' });
    const c = await store.getCampaign(r.campaignId);
    if (!c) return reply.code(404).send({ error: 'campagne introuvable' });
    return reply.type('text/html').send(renderCampaignReportHtml(c, r));
  });

  return { app, runCampaign };
}
