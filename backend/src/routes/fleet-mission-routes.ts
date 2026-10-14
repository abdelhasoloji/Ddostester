import { drsWorkflow } from '../modules/drs/catalog.js';
import { FLEET_INVENTORY_LIMITS } from '../config/limits.js';
import { KillSwitch } from '../modules/probe/probe.js';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import pg from 'pg';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Permission } from '../auth/rbac.js';
import type { Store } from '../store/index.js';
import type { AuthState } from '../auth/guard.js';
import { payloadFromRequest } from '../auth/guard.js';
import { FLEET_LIMITS, type HardCaps } from '../config/limits.js';
import { FleetCoordinator } from '../modules/fleet/coordinator.js';
import { fleetDeviceView } from '../modules/fleet/devices.js';
import { kills } from '../runtime/kills.js';
import { bindPersistentFleet } from '../agents/persistent-fleet.js';
import { AgentError } from '../agents/types.js';
import {
  mutationActor,
  mutationSessionVersion,
  mutationSessionExpiresAt,
} from '../store/audited.js';
import { assertDestination } from '../util/destination.js';

export async function registerFleetMissionRoutes(
  app: FastifyInstance,
  store: Store,
  guard: (permission: Permission) => preHandlerHookHandler,
  auth: AuthState,
  caps: () => HardCaps,
  pool?: pg.Pool,
  effectiveAllowlist: () => Promise<string[]> = async () => ['lab-target'],
) {
  const enabled = process.env.FLEET_MISSIONS_ENABLED === '1';
  app.get('/api/fleet/overview', { preHandler: guard('campaign:read') }, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const devices = (await store.listFleetDevices()).map((d) => ({
      ...fleetDeviceView(d),
      missionCapable: d.heartbeat?.version === 'fleet-mission-agent/v1',
      supportedMethods: d.heartbeat?.version === 'fleet-mission-agent/v1' ? ['GET'] : [],
    }));
    const rows = enabled
      ? await database.query(
          "SELECT id,data FROM fleet_missions_v1 WHERE data ? 'campaignId' ORDER BY data->>'createdAt' DESC LIMIT 10",
        )
      : { rows: [] };
    const campaigns = await store.listCampaigns();
    const missions = await Promise.all(
      rows.rows.map(async (row) => ({
        id: row.id,
        campaignId: row.data.campaignId,
        name: campaigns.find((c) => c.id === row.data.campaignId)?.name ?? row.data.campaignId,
        target: row.data.target,
        createdAt: row.data.createdAt,
        deadline: row.data.deadline,
        deviceIds: row.data.deviceIds,
        snapshot: await coordinator.snapshot(row.id),
      })),
    );
    const allowed = await effectiveAllowlist();
    return {
      enabled,
      observedAt: new Date().toISOString(),
      devices: devices.slice(0, FLEET_INVENTORY_LIMITS.pageSize),
      inventoryCount: devices.length,
      missions,
      caps: envelope(),
      group: drsWorkflow() ? '*' : 'VPS Lab',
      origins: enabled
        ? campaignOrigins.filter((origin) => allowed.includes(new URL(origin).hostname))
        : [],
    };
  });
  const target = 'http://lab-target:8080/';
  const envelope = () => ({
    maxRps: Math.min(FLEET_LIMITS.maxRps, caps().maxRps),
    maxConcurrency: Math.min(FLEET_LIMITS.maxConcurrency, caps().maxConcurrency),
    maxDurationSec: Math.min(FLEET_LIMITS.maxDurationSec, caps().maxDurationSec),
  });
  const policy = () => ({ allowedHosts: ['lab-target'], allowedPorts: [8080], caps: envelope() });
  if (!enabled) {
    app.get('/api/fleet/missions', { preHandler: guard('campaign:read') }, async () => ({
      enabled: false,
      target,
      caps: envelope(),
      missions: [],
    }));
    return;
  }
  if (!auth.enabled || auth.userMode !== 'single' || (!pool && !process.env.DATABASE_URL))
    throw new Error('Fleet missions require authenticated single-user PostgreSQL operation');
  const database = pool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const coordinator = new FleetCoordinator(database);
  await coordinator.init();
  await database.query(`CREATE TABLE IF NOT EXISTS fleet_missions_v1 (
    id text PRIMARY KEY, epoch text NOT NULL, data jsonb NOT NULL)`);
  const epoch = randomUUID();
  // A restarted application never resumes old generation.
  await database.query(`UPDATE fleet_runs_v1 SET state='STOPPING' WHERE state='RUNNING'
    AND run_id IN (SELECT id FROM fleet_missions_v1)`);
  const ownerValid = async (data: Record<string, unknown>) => {
    const user = await store.getUser(String(data.actor));
    const e = envelope();
    return (
      !kills.isStopping() &&
      user?.role === 'admin' &&
      user.status !== 'disabled' &&
      !user.mustChangePassword &&
      (user.tokenVersion ?? 0) === data.version &&
      Number(data.sessionExpiresAt) > Date.now() &&
      Number(data.deadline) > Date.now() &&
      Number(data.maxRps) <= e.maxRps &&
      Number(data.concurrency) <= e.maxConcurrency &&
      Number(data.durationSec) <= e.maxDurationSec
    );
  };
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      const rows = await database.query('SELECT id,data FROM fleet_missions_v1 WHERE epoch=$1', [
        epoch,
      ]);
      for (const row of rows.rows) {
        if (Number(row.data.deadline) + FLEET_LIMITS.stopGraceMs < Date.now()) {
          kills.clear(row.id);
          continue;
        }
        if (!(await ownerValid(row.data))) await coordinator.stop(row.id);
        else await coordinator.renewControl(row.id);
      }
    })()
      .catch((error: unknown) => app.log.error(error, 'Fleet control renewal failed'))
      .finally(() => {
        ticking = false;
      });
  }, 1000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    const rows = await database.query('SELECT id FROM fleet_missions_v1 WHERE epoch=$1', [epoch]);
    for (const row of rows.rows) await coordinator.stop(row.id);
    if (!pool) await database.end();
  });
  const audit = async (actor: string, action: string, id: string) =>
    store.saveAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor,
      action: 'store.mutate',
      detail: `fleet.mission.${action} id=${id}`,
    });
  // Campaigns reuse these same enrolled agents and the same globally reserved envelope.
  // Origins are deployment policy, independently enforced by the worker and NetworkPolicy.
  const campaignOrigins = (process.env.FLEET_CAMPAIGN_ORIGINS ?? 'http://lab-target:8080')
    .split(',')
    .map((s) => new URL(s.trim()).origin);
  const unbind = bindPersistentFleet({
    start: async (config, allowedHosts) => {
      const url = assertDestination(config.url, allowedHosts);
      assertDestination(config.url, await effectiveAllowlist());
      if (!campaignOrigins.includes(url.origin))
        throw new AgentError('Target origin is not enabled for the enrolled Fleet');
      const actor = mutationActor.getStore();
      const version = mutationSessionVersion.getStore();
      const sessionExpiresAt = mutationSessionExpiresAt.getStore();
      const campaignId = config.headers?.['X-WEDOS-TEST']?.split(':')[0];
      if (!actor || version === undefined || !sessionExpiresAt || !campaignId)
        throw new AgentError('Fleet requires a current interactive campaign session');
      const devices = config.fleetDeviceIds
        ? (await Promise.all(config.fleetDeviceIds.map((id) => store.getFleetDevice(id)))).filter(
            (d): d is NonNullable<typeof d> => !!d,
          )
        : (await store.listFleetDevices()).filter((d) => d.group === 'VPS Lab');
      const selected = config.fleetDeviceIds
        ? devices.filter((d) => config.fleetDeviceIds!.includes(d.id))
        : devices;
      if (
        selected.length !== (config.fleetDeviceIds?.length ?? 3) ||
        selected.length < 1 ||
        selected.length > FLEET_LIMITS.maxAgents ||
        selected.some(
          (d) =>
            fleetDeviceView(d).connection !== 'online' ||
            d.heartbeat?.version !== 'fleet-mission-agent/v1',
        )
      )
        throw new AgentError('All selected Fleet agents must be enrolled and online');
      const id = randomUUID();
      const data = {
        id,
        campaignId,
        actor,
        version,
        sessionExpiresAt,
        createdAt: new Date().toISOString(),
        deadline: Date.now() + config.durationSec * 1000,
        target: config.url,
        probeUrl: config.execution?.probeUrl,
        deviceIds: selected.map((d) => d.id),
        agentIds: selected.map((d) => d.agentId),
        agentSites: Object.fromEntries(selected.map((d) => [d.agentId, d.siteId ?? 'vps-lab'])),
        maxRps: config.maxRps,
        concurrency: config.concurrency,
        durationSec: config.durationSec,
      };
      if (!(await ownerValid(data)))
        throw new AgentError('Fleet owner session or current limits are invalid');
      await audit(actor, 'campaign.launch.requested', id);
      try {
        await coordinator.plan(
          {
            runId: id,
            campaignId,
            agentIds: data.agentIds,
            target: config.url,
            maxRps: data.maxRps,
            concurrency: data.concurrency,
            durationSec: data.durationSec,
          },
          {
            allowedHosts: [url.hostname],
            allowedPorts: [Number(url.port || (url.protocol === 'https:' ? 443 : 80))],
            caps: envelope(),
          },
        );
        await database.query('INSERT INTO fleet_missions_v1(id,epoch,data) VALUES($1,$2,$3)', [
          id,
          epoch,
          data,
        ]);
        return id;
      } catch (error) {
        await coordinator.stop(id);
        throw new AgentError(error instanceof Error ? error.message : 'Fleet launch failed');
      }
    },
    stop: (id) => coordinator.stop(id),
    snapshot: (id) => coordinator.snapshot(id),
  });
  app.addHook('onClose', async () => unbind());
  app.get<{ Params: { id: string } }>(
    '/api/fleet/campaigns/:id',
    { preHandler: guard('campaign:read') },
    async (req) => {
      const rows = await database.query(
        "SELECT id,data FROM fleet_missions_v1 WHERE data->>'campaignId'=$1 ORDER BY data->>'createdAt' DESC LIMIT 1",
        [req.params.id],
      );
      const row = rows.rows[0];
      return {
        campaignId: req.params.id,
        mission: row ? { ...row.data, snapshot: await coordinator.snapshot(row.id) } : null,
      };
    },
  );
  app.get('/api/fleet/missions', { preHandler: guard('campaign:read') }, async () => {
    const rows = await database.query(
      "SELECT id,data FROM fleet_missions_v1 ORDER BY data->>'createdAt' DESC LIMIT 20",
    );
    const missions = await Promise.all(
      rows.rows.map(async (row) => ({
        ...row.data,
        snapshot: await coordinator.snapshot(row.id),
      })),
    );
    return { enabled: true, target, caps: envelope(), missions };
  });
  app.post(
    '/api/fleet/missions',
    { preHandler: guard('user:manage'), bodyLimit: 4096 },
    async (req, reply) => {
      if (drsWorkflow())
        return reply
          .code(409)
          .send({ error: 'Legacy missions are retired; configure a DRS Fleet campaign.' });
      const body = req.body as Record<string, unknown> | null;
      const e = envelope();
      if (
        !body ||
        Object.keys(body).some(
          (k) => !['deviceIds', 'maxRps', 'concurrency', 'durationSec', 'confirmed'].includes(k),
        ) ||
        body.confirmed !== true ||
        !Array.isArray(body.deviceIds) ||
        !body.deviceIds.length ||
        body.deviceIds.length > FLEET_LIMITS.maxAgents ||
        new Set(body.deviceIds).size !== body.deviceIds.length ||
        !body.deviceIds.every((id) => typeof id === 'string') ||
        ![body.maxRps, body.concurrency, body.durationSec].every(Number.isSafeInteger) ||
        Number(body.maxRps) < body.deviceIds.length ||
        Number(body.maxRps) > e.maxRps ||
        Number(body.concurrency) < body.deviceIds.length ||
        Number(body.concurrency) > e.maxConcurrency ||
        Number(body.durationSec) < FLEET_LIMITS.minDurationSec ||
        Number(body.durationSec) > e.maxDurationSec
      )
        return reply.code(400).send({ error: 'invalid_mission_or_missing_confirmation' });
      const selected = (await store.listFleetDevices()).filter((d) =>
        (body.deviceIds as unknown[]).includes(d.id),
      );
      if (
        selected.length !== body.deviceIds.length ||
        selected.some(
          (d) =>
            fleetDeviceView(d).connection !== 'online' ||
            d.heartbeat?.version !== 'fleet-mission-agent/v1' ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(d.agentId),
        )
      )
        return reply.code(409).send({ error: 'selected_agents_not_mission_ready' });
      const jwt = payloadFromRequest(auth, req);
      const id = randomUUID();
      const data = {
        id,
        actor: req.authUser!.email,
        version: jwt?.ver ?? 0,
        sessionExpiresAt: (jwt?.exp ?? 0) * 1000,
        createdAt: new Date().toISOString(),
        deadline: Date.now() + Number(body.durationSec) * 1000,
        target,
        deviceIds: body.deviceIds,
        agentIds: selected.map((d) => d.agentId),
        maxRps: Number(body.maxRps),
        concurrency: Number(body.concurrency),
        durationSec: Number(body.durationSec),
      };
      if (!(await ownerValid(data)))
        return reply.code(403).send({ error: 'owner_session_invalid' });
      await audit(data.actor, 'launch.requested', id);
      try {
        await coordinator.plan(
          {
            runId: id,
            campaignId: id,
            agentIds: data.agentIds,
            target,
            maxRps: data.maxRps,
            concurrency: data.concurrency,
            durationSec: data.durationSec,
          },
          policy(),
        );
        await database.query('INSERT INTO fleet_missions_v1(id,epoch,data) VALUES($1,$2,$3)', [
          id,
          epoch,
          data,
        ]);
        const kill = new KillSwitch();
        kill.signal.addEventListener(
          'abort',
          () => {
            void coordinator.stop(id).catch((error) => app.log.error(error));
          },
          { once: true },
        );
        kills.set(id, kill);
        return reply.code(201).send({ ...data, snapshot: await coordinator.snapshot(id) });
      } catch (error) {
        await coordinator.stop(id);
        if (error instanceof Error && error.message.includes('still reserved'))
          return reply.code(409).send({ error: 'fleet_budget_reserved_until_previous_deadline' });
        throw error;
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/fleet/missions/:id/stop',
    { preHandler: guard('user:manage') },
    async (req, reply) => {
      const found = await database.query('SELECT id,data FROM fleet_missions_v1 WHERE id=$1', [
        req.params.id,
      ]);
      if (!found.rows.length) return reply.code(404).send({ error: 'not_found' });
      await audit(req.authUser!.email, 'stop.requested', req.params.id);
      if (found.rows[0].data.campaignId)
        kills.get(found.rows[0].data.campaignId)?.trigger('KILLED_MANUAL');
      await coordinator.stop(req.params.id);
      return { snapshot: await coordinator.snapshot(req.params.id) };
    },
  );
  const agent = async (id: string, authorization?: string) => {
    const token = authorization?.replace(/^Bearer /, '');
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const device = await store.getFleetDevice(id);
    if (
      !device?.credential ||
      device.enrollmentRevoked ||
      device.credential.expiresAt <= Date.now() ||
      !timingSafeEqual(
        Buffer.from(device.credential.hash, 'hex'),
        createHash('sha256').update(token).digest(),
      )
    )
      return null;
    return device;
  };
  app.post<{ Params: { id: string; action: string } }>(
    '/api/fleet/devices/:id/mission/:action',
    { bodyLimit: FLEET_LIMITS.maxMessageBytes },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const device = await agent(req.params.id, req.headers.authorization);
      if (!device) return reply.code(401).send({ error: 'invalid_agent_credential' });
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return reply.code(400).send({ error: 'invalid_message' });
      if (req.params.action === 'claim') {
        const rows = await database.query(
          "SELECT id,data FROM fleet_missions_v1 WHERE epoch=$1 ORDER BY data->>'createdAt' DESC LIMIT 1",
          [epoch],
        );
        const row = rows.rows[0];
        if (!row || !row.data.deviceIds.includes(device.id) || !(await ownerValid(row.data)))
          return { assignment: null };
        return { assignment: await coordinator.claim(row.id, device.agentId) };
      }
      if (typeof body.runId !== 'string' || typeof body.attemptId !== 'string')
        return reply.code(400).send({ error: 'invalid_identity' });
      const rows = await database.query(
        'SELECT data FROM fleet_missions_v1 WHERE id=$1 AND epoch=$2',
        [body.runId, epoch],
      );
      const row = rows.rows[0];
      if (!row || !row.data.deviceIds.includes(device.id))
        return reply.code(403).send({ error: 'wrong_mission' });
      if (req.params.action === 'renew') {
        if (!(await ownerValid(row.data))) {
          await coordinator.stop(body.runId);
          return { lease: null };
        }
        try {
          return {
            lease: await coordinator.heartbeat(
              body.runId,
              device.agentId,
              body.attemptId,
              Number(body.sequence),
              body.progress as never,
            ),
          };
        } catch {
          return reply.code(400).send({ error: 'invalid_progress' });
        }
      }
      if (req.params.action === 'result') {
        if (
          !body.result ||
          typeof body.result !== 'object' ||
          Array.isArray(body.result) ||
          !['SUCCEEDED', 'STOPPED', 'FAILED'].includes(String(body.state))
        )
          return reply.code(400).send({ error: 'invalid_result' });
        return {
          accepted: await coordinator.finish(
            body.runId,
            device.agentId,
            body.attemptId,
            body.state as 'SUCCEEDED' | 'STOPPED' | 'FAILED',
            body.result as Record<string, unknown>,
          ),
        };
      }
      return reply.code(404).send({ error: 'unknown_action' });
    },
  );
}
