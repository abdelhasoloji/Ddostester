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
import { reArmRecurring } from './modules/campaigns/scheduler.js';
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
import { signJwt } from './auth/jwt.js';
import { hashPassword, verifyPassword } from './auth/passwords.js';
import { can } from './auth/rbac.js';
import type { Permission, Role } from './auth/rbac.js';
import { assertDelete, assertUpsert, combineUsers, UserError } from './modules/users/service.js';
import { BuiltinHttpAgent } from './agents/builtin.js';
import { createAgent, describeAgents, agentChoices } from './agents/index.js';
import { AgentError, type AttackAgent } from './agents/types.js';
import { buildRunNotifications } from './modules/notify/events.js';
import { noopNotifier } from './modules/notify/notifier.js';
import type { Notifier } from './modules/notify/types.js';
import { noopProtectionProvider } from './modules/protection/provider.js';
import type { ProtectionProvider } from './modules/protection/types.js';
import {
  PLAYBOOKS,
  getPlaybook,
  buildSuiteCampaigns,
  validatePlaybookInput,
  PlaybookError,
} from './modules/playbooks/playbooks.js';
import { buildSuites, renderSuiteReportHtml } from './modules/playbooks/suites.js';

export interface BuildOptions {
  store: Store;
  auth: AuthState;
  allowedTargets: string[];
  logger?: boolean;
  serveStatic?: boolean;
  /** Load agent (default: built-in bounded HTTP generator). */
  agent?: AttackAgent;
  /** Notification sink (default: no-op — notifications are opt-in). */
  notifier?: Notifier;
  /** Protection integration for real detection/mitigation (default: no-op). */
  protection?: ProtectionProvider;
}

export interface BuiltApp {
  app: FastifyInstance;
  runCampaign: (c: Campaign, actor: string) => Promise<CampaignRun>;
}

/** Builds the Fastify app (routes + logic) without starting to listen. */
export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { store, auth, allowedTargets } = opts;
  const agent = opts.agent ?? new BuiltinHttpAgent();
  const notifier = opts.notifier ?? noopNotifier;
  const protection = opts.protection ?? noopProtectionProvider;

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            // Never log tokens passed in the query (?token=) or the Authorization header.
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
      if (!id) return reply.code(401).send({ error: 'authentication required' });
      req.authUser = id;
      if (!can(id.role, perm)) return reply.code(403).send({ error: `missing ${perm} permission` });
    };
  }

  /** Verifies a read token passed in the query (browser links: report, SSE). */
  function readTokenAllowed(req: FastifyRequest): boolean {
    if (!auth.enabled) return true;
    const { token } = req.query as { token?: string };
    const id = token
      ? identityFromRequest(auth, {
          headers: { authorization: `Bearer ${token}` },
        } as FastifyRequest)
      : identityFromRequest(auth, req);
    return id !== null && can(id.role, 'campaign:read');
  }

  if (opts.serveStatic !== false) {
    const frontendDist = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'frontend',
      'dist',
    );
    if (existsSync(frontendDist)) {
      await app.register(fastifyStatic, { root: frontendDist });
      app.log.info(`UI served from ${frontendDist}`);
      // SPA fallback: browser routes (react-router) that are neither /api nor
      // /metrics return index.html (deep links such as /campaigns).
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.url && (req.raw.url.startsWith('/api') || req.raw.url.startsWith('/metrics'))) {
          return reply.code(404).send({ error: 'not found' });
        }
        return reply.sendFile('index.html');
      });
    }
  }

  function fail(err: unknown, reply: FastifyReply) {
    if (err instanceof CampaignError) return reply.code(400).send({ error: err.message });
    if (err instanceof AgentError) return reply.code(503).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  }

  async function auditAs(
    actor: string,
    action: AuditEntry['action'],
    campaignId?: string,
    detail?: string,
  ) {
    try {
      await store.saveAudit({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor,
        action,
        campaignId,
        detail,
      });
    } catch (err) {
      app.log.error({ err }, 'failed to write audit entry');
    }
  }
  const audit = (
    req: FastifyRequest,
    action: AuditEntry['action'],
    campaignId?: string,
    detail?: string,
  ) => auditAs(req.authUser?.email ?? 'dev', action, campaignId, detail);

  async function runCampaign(c: Campaign, actor: string): Promise<CampaignRun> {
    const kill = new KillSwitch();
    kills.set(c.id, kill);
    await store.saveCampaign(transition(c, 'RUNNING'));
    // Per-campaign engine, falling back to the server default agent.
    const runAgent = createAgent(c.agent) ?? agent;
    const onProgress = (p: LoadProgress) =>
      liveProgress.set(c.id, {
        ...p,
        maxDurationSec: c.maxDurationSec,
        status: 'RUNNING',
        engine: runAgent.name,
      });
    try {
      const run = await executeCampaign(c, allowedTargets, kill, onProgress, runAgent, protection);
      await store.saveRun(run);
      // Recurring campaigns re-arm for their next run (within the approval
      // window); otherwise the campaign settles into its terminal run status.
      const rearm = reArmRecurring(c, Date.now());
      await store.saveCampaign({
        ...c,
        status: rearm ? 'APPROVED' : run.status,
        scheduledAt: rearm ? rearm.scheduledAt : c.scheduledAt,
        wrs: run.wrs,
        runId: run.runId,
      });
      await auditAs(
        actor,
        'campaign.execute',
        c.id,
        `${run.status} · WRS ${run.wrs.wrs} (${run.wrs.level})`,
      );
      // Notify the team (opt-in sink): outcome + regression. Never let a failing
      // sink break the run — notifications are best-effort.
      try {
        const [allCampaigns, allRuns] = await Promise.all([
          store.listCampaigns(),
          store.listRuns(),
        ]);
        let host = c.target;
        try {
          host = new URL(c.target).hostname;
        } catch {
          /* keep raw */
        }
        const series = buildWrsHistory(allCampaigns, allRuns).find((s) => s.target === host);
        for (const ev of buildRunNotifications(c, run, series)) {
          await notifier.notify(ev);
        }
      } catch (err) {
        app.log.error({ err }, 'failed to emit notifications');
      }
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
    agent: agent.name,
    notifications: notifier.sinks,
    protection: protection.configured,
  }));

  // Send a test notification so operators can verify their sink is wired up.
  app.post('/api/notify/test', { preHandler: guard('campaign:create') }, async (_req, reply) => {
    if (notifier.sinks.length === 0) {
      return reply.code(400).send({ error: 'no notification sink configured' });
    }
    await notifier.notify({
      kind: notifier.events[0] ?? 'campaign.completed',
      severity: 'info',
      title: '🔔 ShieldTest test notification',
      text: 'Test notification from WEDOS ShieldTest — your sink is wired up correctly.',
      at: new Date().toISOString(),
      fields: [{ label: 'Sinks', value: notifier.sinks.join(', ') }],
    });
    return { delivered: true, sinks: notifier.sinks };
  });

  // Load engines and their live availability (bounded HTTP, delegated tools).
  app.get('/api/agents', async () => {
    const list = await describeAgents();
    return { default: agent.name, agents: list };
  });

  // Anti-brute-force: temporary lock after several failures (per email+IP).
  const loginFails = new Map<string, { count: number; until: number }>();
  const MAX_FAILS = 5;
  const LOCK_MS = 60_000;

  app.post('/api/auth/login', async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication disabled' });
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) return reply.code(400).send({ error: 'email and password required' });
    const key = `${email.toLowerCase()}|${req.ip}`;
    const entry = loginFails.get(key);
    if (entry && entry.count >= MAX_FAILS && Date.now() < entry.until) {
      return reply.code(429).send({ error: 'too many attempts — try again later' });
    }
    // Env-defined users first (unchanged path); then runtime store users.
    let res = login(auth, email, password);
    if (!res) {
      const su = await store.getUser(email.toLowerCase());
      if (su && verifyPassword(password, su.passwordHash)) {
        res = {
          token: signJwt({ sub: su.email, role: su.role }, auth.secret),
          email: su.email,
          role: su.role,
        };
      }
    }
    if (!res) {
      loginFails.set(key, { count: (entry?.count ?? 0) + 1, until: Date.now() + LOCK_MS });
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    loginFails.delete(key);
    return res;
  });

  app.get('/api/auth/me', { preHandler: guard('campaign:read') }, async (req) => {
    return req.authUser ?? { email: null, role: null, authRequired: false };
  });

  // --- User management (officer only; env users are immutable) ---------------
  const envUsers = (): { email: string; role: Role }[] =>
    [...auth.users.values()].map((u) => ({ email: u.email, role: u.role }));
  const envEmailSet = (): Set<string> => new Set([...auth.users.keys()]);

  app.get('/api/users', { preHandler: guard('user:manage') }, async (_req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    const store_ = (await store.listUsers()).map((u) => ({ email: u.email, role: u.role }));
    return combineUsers(envUsers(), store_);
  });

  app.post('/api/users', { preHandler: guard('user:manage') }, async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    try {
      const body = req.body as { email?: string; role?: string; password?: string };
      const store_ = (await store.listUsers()).map((u) => ({ email: u.email, role: u.role }));
      const current = combineUsers(envUsers(), store_);
      const { email, role } = assertUpsert(
        { email: body.email ?? '', role: body.role ?? '', password: body.password ?? '' },
        { envEmails: envEmailSet(), current, actorEmail: req.authUser?.email ?? '' },
      );
      await store.saveUser({ email, role, passwordHash: hashPassword(body.password ?? '') });
      await audit(req, 'user.upsert', undefined, `${email} → ${role}`);
      return reply.code(201).send({ email, role, source: 'store' });
    } catch (err) {
      if (err instanceof UserError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

  app.delete('/api/users/:email', { preHandler: guard('user:manage') }, async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    try {
      const raw = decodeURIComponent((req.params as { email: string }).email);
      const store_ = (await store.listUsers()).map((u) => ({ email: u.email, role: u.role }));
      const current = combineUsers(envUsers(), store_);
      const email = assertDelete(raw, {
        envEmails: envEmailSet(),
        current,
        actorEmail: req.authUser?.email ?? '',
      });
      await store.deleteUser(email);
      await audit(req, 'user.delete', undefined, email);
      return { deleted: email };
    } catch (err) {
      if (err instanceof UserError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

  app.get('/api/campaigns', { preHandler: guard('campaign:read') }, async () =>
    store.listCampaigns(),
  );

  app.get('/api/campaigns/:id', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const c = await store.getCampaign((req.params as { id: string }).id);
    return c ?? reply.code(404).send({ error: 'campaign not found' });
  });

  app.post('/api/campaigns', { preHandler: guard('campaign:create') }, async (req, reply) => {
    try {
      const input = req.body as CampaignInput;
      if (req.authUser) input.createdBy = req.authUser.email;
      const campaign = createCampaign(input, allowedTargets, agentChoices());
      await store.saveCampaign(campaign);
      await audit(req, 'campaign.create', campaign.id, `${campaign.name} → ${campaign.target}`);
      return reply.code(201).send(campaign);
    } catch (err) {
      return fail(err, reply);
    }
  });

  // Assessment playbooks: curated + user-defined sequences of bounded campaigns.
  app.get('/api/playbooks', { preHandler: guard('campaign:read') }, async () => {
    const curated = PLAYBOOKS.map((p) => ({ ...p, custom: false }));
    const custom = await store.listPlaybooks();
    return [...curated, ...custom];
  });

  app.post('/api/playbooks', { preHandler: guard('campaign:create') }, async (req, reply) => {
    try {
      const pb = validatePlaybookInput(req.body);
      await store.savePlaybook(pb);
      await audit(req, 'playbook.upsert', undefined, `${pb.name} (${pb.steps.length} steps)`);
      return reply.code(201).send(pb);
    } catch (err) {
      if (err instanceof PlaybookError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

  app.delete('/api/playbooks/:id', { preHandler: guard('campaign:create') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!id.startsWith('custom-')) {
      return reply.code(400).send({ error: 'only custom playbooks can be deleted' });
    }
    const existing = await store.getPlaybook(id);
    if (!existing) return reply.code(404).send({ error: 'playbook not found' });
    await store.deletePlaybook(id);
    await audit(req, 'playbook.delete', undefined, existing.name);
    return { deleted: id };
  });

  app.post(
    '/api/playbooks/:id/instantiate',
    { preHandler: guard('campaign:create') },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const pb = getPlaybook(id) ?? (await store.getPlaybook(id));
      if (!pb) return reply.code(404).send({ error: 'playbook not found' });
      const body = req.body as { target?: string; probeUrl?: string; recurrenceMin?: number };
      if (!body.target) return reply.code(400).send({ error: 'target is required' });
      try {
        const engines = (await describeAgents()).map((a) => ({ id: a.id, available: a.available }));
        const inputs = buildSuiteCampaigns(
          pb,
          {
            target: body.target,
            probeUrl: body.probeUrl || body.target,
            createdBy: req.authUser?.email ?? 'dev',
            recurrenceMin: body.recurrenceMin,
          },
          engines,
        );
        const created: Campaign[] = [];
        for (const input of inputs) {
          const campaign = createCampaign(input, allowedTargets, agentChoices());
          await store.saveCampaign(campaign);
          created.push(campaign);
        }
        await audit(
          req,
          'campaign.create',
          undefined,
          `playbook "${pb.name}" → ${created.length} campaigns (suite ${created[0]?.suiteId})`,
        );
        return reply.code(201).send({ suiteId: created[0]?.suiteId, campaigns: created });
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  app.post(
    '/api/campaigns/:id/approval',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      try {
        const c = await store.getCampaign((req.params as { id: string }).id);
        if (!c) return reply.code(404).send({ error: 'campaign not found' });
        const body = req.body as {
          approvedBy?: string;
          decision: 'APPROVED' | 'REJECTED';
          reason?: string;
        };
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
    },
  );

  app.post(
    '/api/campaigns/:id/execute',
    { preHandler: guard('campaign:execute') },
    async (req, reply) => {
      const c = await store.getCampaign((req.params as { id: string }).id);
      if (!c) return reply.code(404).send({ error: 'campaign not found' });
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
    },
  );

  app.get('/api/campaigns/:id/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
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

  app.post(
    '/api/campaigns/:id/kill',
    { preHandler: guard('campaign:kill') },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const kill = kills.get(id);
      if (!kill) return reply.code(404).send({ error: 'no run in progress' });
      kill.trigger('KILLED_MANUAL');
      await audit(req, 'campaign.kill', id);
      return { status: 'KILLED_MANUAL' };
    },
  );

  // Consolidated assessment suites (campaigns grouped by playbook run).
  app.get('/api/suites', { preHandler: guard('campaign:read') }, async () =>
    buildSuites(await store.listCampaigns()),
  );

  app.get('/api/suites/:id', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const suite = buildSuites(await store.listCampaigns()).find(
      (s) => s.suiteId === (req.params as { id: string }).id,
    );
    return suite ?? reply.code(404).send({ error: 'suite not found' });
  });

  app.get('/api/suites/:id/report', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const suite = buildSuites(await store.listCampaigns()).find(
      (s) => s.suiteId === (req.params as { id: string }).id,
    );
    if (!suite) return reply.code(404).send({ error: 'suite not found' });
    return reply.type('text/html').send(renderSuiteReportHtml(suite));
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
    return r ?? reply.code(404).send({ error: 'run not found' });
  });

  app.get('/api/reports/compliance', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const { from, to } = req.query as { from?: string; to?: string };
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return reply.type('text/html').send(renderComplianceHtml(campaigns, runs, { from, to }));
  });

  app.get('/api/runs/:runId/report', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const r = await store.getRun((req.params as { runId: string }).runId);
    if (!r) return reply.code(404).send({ error: 'run not found' });
    const c = await store.getCampaign(r.campaignId);
    if (!c) return reply.code(404).send({ error: 'campaign not found' });
    return reply.type('text/html').send(renderCampaignReportHtml(c, r));
  });

  return { app, runCampaign };
}
