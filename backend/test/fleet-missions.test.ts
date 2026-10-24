import {
  defaultPlan,
  createRevision,
  currentRevision,
  freeze,
} from '../src/modules/drs/workflow.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import Fastify from 'fastify';
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerFleetMissionRoutes } from '../src/routes/fleet-mission-routes.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { signJwt } from '../src/auth/jwt.js';
import { PersistentFleetHttpAgent } from '../src/agents/persistent-fleet.js';
import {
  mutationActor,
  mutationSessionVersion,
  mutationSessionExpiresAt,
} from '../src/store/audited.js';
import { latencyHistogram } from '../src/engine/stats.js';
import { LATENCY_BUCKETS_MS } from '../src/config/limits.js';
const url = process.env.DATABASE_URL_TEST;
(url ? describe : describe.skip)('registered fleet mission orchestration (PostgreSQL)', () => {
  const app = Fastify({ logger: false });
  const pool = new pg.Pool({ connectionString: url });
  const store = new MemoryStore();
  const auth = initAuth({
    AUTH_JWT_SECRET: 'test-only-mission',
    USER_MODE: 'single',
  } as NodeJS.ProcessEnv);
  const tokens = [
    randomBytes(32).toString('hex'),
    randomBytes(32).toString('hex'),
    randomBytes(32).toString('hex'),
  ];
  const userHeaders = {
    authorization:
      'Bearer ' + signJwt({ sub: 'abdelha@wedos', role: 'admin', ver: 0 }, auth.secret),
  };
  let id = '';
  let packetMissionId = '';
  beforeAll(async () => {
    vi.stubEnv('FLEET_MISSIONS_ENABLED', '1');
    await store.saveUser({
      email: 'abdelha@wedos',
      role: 'admin',
      passwordHash: 'test-only',
      tokenVersion: 0,
    });
    for (let i = 0; i < 3; i++)
      await store.saveFleetDevice({
        id: 'mission-test-' + i,
        agentId: 'mission-test-' + i,
        name: 'test',
        group: 'VPS Lab',
        profile: 'sensor',
        privateIp: '10.1.1.' + (i + 1),
        notes: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        credential: {
          hash: createHash('sha256').update(tokens[i]).digest('hex'),
          expiresAt: Date.now() + 60000,
        },
        heartbeat: {
          sequence: 1,
          receivedAt: Date.now(),
          version: 'fleet-mission-agent/v1',
          uptimeSec: 1,
          peerIp: '127.0.0.1',
        },
      });
    await registerFleetMissionRoutes(
      app,
      store,
      () => async (req, reply) => {
        if (req.headers.authorization !== userHeaders.authorization) {
          await reply.code(403).send({ error: 'forbidden' });
          return;
        }
        req.authUser = { email: 'abdelha@wedos', role: 'admin' };
      },
      auth,
      () => ({ maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 }),
      pool,
    );
  });
  afterAll(async () => {
    await app.close();
    for (const missionId of [id, packetMissionId].filter(Boolean)) {
      await pool.query('DELETE FROM fleet_missions_v1 WHERE id=$1', [missionId]);
      await pool.query('DELETE FROM fleet_shards_v1 WHERE run_id=$1', [missionId]);
      await pool.query('DELETE FROM fleet_runs_v1 WHERE run_id=$1', [missionId]);
    }
    await pool.end();
    vi.unstubAllEnvs();
  });
  it('rejects missing confirmation and agent credentials on operator routes', async () => {
    const payload = {
      deviceIds: tokens.map((_, i) => 'mission-test-' + i),
      maxRps: 3,
      concurrency: 3,
      durationSec: 20,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/fleet/missions',
          headers: userHeaders,
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/fleet/missions',
          headers: { authorization: 'Bearer ' + tokens[0] },
          payload: { ...payload, confirmed: true },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('claims selected existing agents once, enforces shared budget, stop acknowledgment and revocation', async () => {
    const launched = await app.inject({
      method: 'POST',
      url: '/api/fleet/missions',
      headers: userHeaders,
      payload: {
        deviceIds: tokens.map((_, i) => 'mission-test-' + i),
        maxRps: 3,
        concurrency: 3,
        durationSec: 20,
        confirmed: true,
      },
    });
    expect(launched.statusCode).toBe(201);
    id = launched.json().id;
    expect(
      launched
        .json()
        .snapshot.shards.reduce(
          (n: number, s: { budget: { maxRps: number } }) => n + s.budget.maxRps,
          0,
        ),
    ).toBe(3);
    const agentHeaders = { authorization: 'Bearer ' + tokens[0] };
    const path = '/api/fleet/devices/mission-test-0/mission/';
    const claim = await app.inject({
      method: 'POST',
      url: path + 'claim',
      headers: agentHeaders,
      payload: {},
    });
    const assignment = claim.json().assignment;
    expect(assignment.agentId).toBe('mission-test-0');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path + 'claim',
          headers: agentHeaders,
          payload: {},
        })
      ).json().assignment,
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/fleet/missions/' + id + '/stop',
          headers: userHeaders,
        })
      ).json().snapshot.state,
    ).toBe('STOPPING');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path + 'renew',
          headers: agentHeaders,
          payload: { runId: id, attemptId: assignment.attemptId, sequence: 1 },
        })
      ).json().lease,
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path + 'result',
          headers: agentHeaders,
          payload: {
            runId: id,
            attemptId: assignment.attemptId,
            state: 'STOPPED',
            result: { reason: 'control_lost' },
          },
        })
      ).json().accepted,
    ).toBe(true);
    const device = (await store.listFleetDevices())[0];
    delete device.credential;
    await store.saveFleetDevice(device);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path + 'claim',
          headers: agentHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await store.listAuditChain()).some((a) =>
        a.detail?.includes('fleet.mission.stop.requested'),
      ),
    ).toBe(true);
  });
  it('executes the campaign adapter through the same durable assignments and enrolled agent API', async () => {
    const campaign: Campaign = {
      id: 'parent-campaign',
      name: 'DRS metrics fixture',
      status: 'APPROVED',
      createdBy: 'fixture',
      createdAt: new Date().toISOString(),
      target: 'http://lab-target:8080/',
      probeUrl: 'http://lab-target:8080/',
      authorized: true,
      agent: 'fleet',
      vector: 'http-get',
      maxRps: 3,
      concurrency: 3,
      maxDurationSec: 20,
    };
    campaign.drsDocument = createRevision(
      undefined,
      defaultPlan(campaign, 'synthetic-lab'),
      'fixture',
    );
    const revision = currentRevision(campaign.drsDocument);
    freeze(revision, campaign);
    await store.saveCampaign(campaign);

    // Remove only this test's previous run so its deliberately reserved envelope cannot overlap.
    await pool.query('DELETE FROM fleet_missions_v1 WHERE id=$1', [id]);
    await pool.query('DELETE FROM fleet_shards_v1 WHERE run_id=$1', [id]);
    await pool.query('DELETE FROM fleet_runs_v1 WHERE run_id=$1', [id]);
    const first = (await store.listFleetDevices()).find((d) => d.id === 'mission-test-0')!;
    first.credential = {
      hash: createHash('sha256').update(tokens[0]).digest('hex'),
      expiresAt: Date.now() + 60000,
    };
    await store.saveFleetDevice(first);
    const abort = new AbortController();
    const run = mutationActor.run('abdelha@wedos', () =>
      mutationSessionVersion.run(0, () =>
        mutationSessionExpiresAt.run(Date.now() + 60000, () =>
          new PersistentFleetHttpAgent().run(
            {
              url: 'http://lab-target:8080/',
              authorized: true,
              maxRps: 3,
              concurrency: 3,
              durationSec: 20,
              headers: { 'X-WEDOS-TEST': 'parent-campaign:trace' },
              execution: {
                engine: 'iot-fleet',
                runtime: 'test',
                sourceRef: 'test',
                probeUrl: 'http://lab-target:8080/status',
                probeVantage: 'local',
              },
            },
            ['lab-target'],
            abort.signal,
          ),
        ),
      ),
    );
    let assignment;
    for (let attempt = 0; attempt < 30 && !assignment; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/fleet/devices/mission-test-0/mission/claim',
        headers: { authorization: 'Bearer ' + tokens[0] },
        payload: {},
      });
      assignment = response.json().assignment;
      if (!assignment) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(assignment.campaignId).toBe('parent-campaign');
    id = assignment.runId;
    const monitoring = await app.inject({ url: '/metrics/fleet' });
    expect(monitoring.statusCode).toBe(200);
    expect(monitoring.body).toContain(`revision_id="${revision.id}"`);
    expect(monitoring.body).toMatch(/agents_unknown\{[^\n]+\} 3/);
    expect(monitoring.body).toContain('mode="synthetic-lab"');
    const assignments = [assignment];
    for (let i = 1; i < 3; i++)
      assignments.push(
        (
          await app.inject({
            method: 'POST',
            url: `/api/fleet/devices/mission-test-${i}/mission/claim`,
            headers: { authorization: 'Bearer ' + tokens[i] },
            payload: {},
          })
        ).json().assignment,
      );
    abort.abort();
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/fleet/devices/mission-test-${i}/mission/result`,
        headers: { authorization: 'Bearer ' + tokens[i] },
        payload: {
          runId: id,
          attemptId: assignments[i].attemptId,
          state: 'STOPPED',
          result: {
            reason: 'control_lost',
            generator: {
              totalRequests: 1,
              successful: 1,
              failed: 0,
              latencyMs: { min: 10, max: 10 },
              latencyHistogram: latencyHistogram([10], LATENCY_BUCKETS_MS),
              statusCounts: { '2xx': 1 },
              errors: {},
            },
          },
        },
      });
      expect(response.json().accepted).toBe(true);
    }
    const result = await run;
    expect(result.fleet?.shards).toHaveLength(3);
    expect(result.totalRequests).toBe(3);
    const observed = await app.inject({
      url: '/api/fleet/campaigns/parent-campaign',
      headers: userHeaders,
    });
    const overview = await app.inject({ url: '/api/fleet/overview', headers: userHeaders });
    expect(
      overview
        .json()
        .devices.every((d: { supportedMethods: string[] }) => d.supportedMethods[0] === 'GET'),
    ).toBe(true);
    expect(JSON.stringify(overview.json())).not.toContain(tokens[0]);
    expect(overview.json().missions[0].campaignId).toBe('parent-campaign');
    expect(
      observed
        .json()
        .mission.snapshot.shards.every((s: { state: string }) => s.state === 'STOPPED'),
    ).toBe(true);
  });
  it('rejects malformed and revoked worker messages without treating them as progress', async () => {
    const path = '/api/fleet/devices/mission-test-1/mission/';
    const headers = { authorization: 'Bearer ' + tokens[1] };
    for (const authorization of [undefined, 'Bearer invalid', 'Bearer ' + 'a'.repeat(64)]) {
      const response = await app.inject({
        method: 'POST',
        url: path + 'claim',
        headers: authorization ? { authorization } : {},
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    }
    for (const payload of [[], 'invalid']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path + 'claim',
            headers: { ...headers, 'content-type': 'application/json' },
            payload: JSON.stringify(payload),
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (await app.inject({ method: 'POST', url: path + 'renew', headers, payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path + 'renew',
          headers,
          payload: { runId: 'not-a-mission', attemptId: 'unknown' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path + 'unknown',
          headers,
          payload: { runId: id, attemptId: 'unknown' },
        })
      ).statusCode,
    ).toBe(404);
    const d = (await store.getFleetDevice('mission-test-1'))!;
    await store.saveFleetDevice({ ...d, enrollmentRevoked: true });
    expect(
      (await app.inject({ method: 'POST', url: path + 'claim', headers, payload: {} })).statusCode,
    ).toBe(401);
    await store.saveFleetDevice({ ...d, credential: { ...d.credential!, expiresAt: 1 } });
    expect(
      (await app.inject({ method: 'POST', url: path + 'claim', headers, payload: {} })).statusCode,
    ).toBe(401);
    await store.saveFleetDevice(d);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/fleet/missions/not-found/stop',
          headers: userHeaders,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('rejects unsafe legacy input and refuses legacy dispatch under the DRS catalogue', async () => {
    const body = {
      deviceIds: ['mission-test-1'],
      maxRps: 1,
      concurrency: 1,
      durationSec: 10,
      confirmed: true,
    };
    for (const patch of [
      { arbitrary: true },
      { deviceIds: [] },
      { deviceIds: ['mission-test-1', 'mission-test-1'] },
      { deviceIds: [1] },
      { maxRps: 0 },
      { maxRps: 16 },
      { maxRps: 1.5 },
      { concurrency: 0 },
      { concurrency: 7 },
      { durationSec: 9 },
      { durationSec: 61 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/fleet/missions',
        headers: userHeaders,
        payload: { ...body, ...patch },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/fleet/missions',
          headers: userHeaders,
          payload: { ...body, deviceIds: ['unregistered'] },
        })
      ).statusCode,
    ).toBe(409);
    vi.stubEnv('CAMPAIGN_CATALOG', 'drs-fleet');
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/fleet/missions',
            headers: userHeaders,
            payload: body,
          })
        ).statusCode,
      ).toBe(409);
      const overview = (
        await app.inject({ url: '/api/fleet/overview', headers: userHeaders })
      ).json();
      expect(overview.group).toBe('*');
      expect(overview.origins).toEqual(['http://lab-target:8080']);
    } finally {
      vi.stubEnv('CAMPAIGN_CATALOG', 'legacy');
    }
  });
  it('persists a packet mission as a v3 shard the agent can claim', async () => {
    const token = randomBytes(32).toString('hex');
    await store.saveFleetDevice({
      id: 'packet-agent',
      agentId: 'packet-agent',
      name: 'packet',
      group: 'VPS Lab',
      profile: 'generic',
      privateIp: '10.1.1.9',
      notes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      credential: {
        hash: createHash('sha256').update(token).digest('hex'),
        expiresAt: Date.now() + 60_000,
      },
      heartbeat: {
        sequence: 1,
        receivedAt: Date.now(),
        version: 'fleet-mission-agent/v2',
        uptimeSec: 1,
        peerIp: '127.0.0.1',
      },
    });
    const payload = { kind: 'syn', port: 18099, pps: 25_000, durationSec: 10 };
    // La cible paquet doit être nommée, jamais déduite du premier hôte autorisé.
    const unnamed = await app.inject({
      method: 'POST',
      url: '/api/fleet/missions',
      headers: userHeaders,
      payload,
    });
    expect(unnamed.statusCode).toBe(409);
    expect(unnamed.json().error).toContain('FLEET_PACKET_TARGET');
    vi.stubEnv('FLEET_PACKET_TARGET', 'bank.cz');
    const outside = await app.inject({
      method: 'POST',
      url: '/api/fleet/missions',
      headers: userHeaders,
      payload,
    });
    expect(outside.statusCode).toBe(409);
    expect(outside.json().error).toContain('not allowlisted');
    vi.stubEnv('FLEET_PACKET_TARGET', 'lab-target');
    const launched = await app.inject({
      method: 'POST',
      url: '/api/fleet/missions',
      headers: userHeaders,
      payload,
    });
    expect(launched.statusCode).toBe(202);
    const body = launched.json();
    expect(body.id).toBeTruthy();
    expect(body.missionId).toBe(body.id);
    packetMissionId = body.id;

    const mission = await pool.query('SELECT data FROM fleet_missions_v1 WHERE id=$1', [body.id]);
    expect(mission.rows[0].data).toMatchObject({
      kind: 'syn',
      pps: 25_000,
      port: 18099,
      durationSec: 10,
      deadline: body.assignment.deadline,
      agentIds: ['packet-agent'],
    });
    const shard = await pool.query(
      'SELECT assignment,state,site FROM fleet_shards_v1 WHERE run_id=$1 AND agent_id=$2',
      [body.id, 'packet-agent'],
    );
    expect(shard.rows[0].state).toBe('PENDING');
    expect(shard.rows[0].assignment.schema).toBe('ddostester.fleet.assignment/v3');
    expect(shard.rows[0].assignment.pps).toBe(25_000);
    expect(shard.rows[0].assignment.configHash).toBe(body.assignment.configHash);
    const run = await pool.query('SELECT state FROM fleet_runs_v1 WHERE run_id=$1', [body.id]);
    expect(run.rows[0].state).toBe('RUNNING');

    const claimed = await app.inject({
      method: 'POST',
      url: '/api/fleet/devices/packet-agent/mission/claim',
      headers: { authorization: 'Bearer ' + token },
      payload: {},
    });
    expect(claimed.statusCode).toBe(200);
    const assignment = claimed.json().assignment;
    expect(assignment.schema).toBe('ddostester.fleet.assignment/v3');
    expect(assignment.runId).toBe(body.id);
    expect(assignment.agentId).toBe('packet-agent');
  });

  it('refuses campaign assignment without a current owner session, exact enrolled identities or admitted origin', async () => {
    const agent = new PersistentFleetHttpAgent();
    const config = {
      url: 'http://lab-target:8080/',
      authorized: true,
      maxRps: 3,
      concurrency: 3,
      durationSec: 10,
      headers: { 'X-WEDOS-TEST': 'rejection-fixture:trace' },
      fleetDeviceIds: ['mission-test-0', 'mission-test-1', 'mission-test-2'],
    };
    await expect(agent.run(config, ['lab-target'])).rejects.toThrow('interactive campaign session');
    const session = <T>(f: () => T) =>
      mutationActor.run('abdelha@wedos', () =>
        mutationSessionVersion.run(0, () => mutationSessionExpiresAt.run(Date.now() + 60000, f)),
      );
    await expect(
      session(() => agent.run({ ...config, url: 'http://lab-target:8081/' }, ['lab-target'])),
    ).rejects.toThrow('origin');
    await expect(
      session(() => agent.run({ ...config, fleetDeviceIds: ['missing'] }, ['lab-target'])),
    ).rejects.toThrow('enrolled and online');
    const d = (await store.getFleetDevice('mission-test-1'))!;
    await store.saveFleetDevice({
      ...d,
      heartbeat: { ...d.heartbeat!, version: 'inventory-heartbeat/v1' },
    });
    await expect(session(() => agent.run(config, ['lab-target']))).rejects.toThrow(
      'enrolled and online',
    );
    await store.saveFleetDevice(d);
    const owner = (await store.getUser('abdelha@wedos'))!;
    for (const patch of [
      { status: 'disabled' as const },
      { mustChangePassword: true },
      { tokenVersion: 1 },
    ]) {
      await store.saveUser({ ...owner, ...patch });
      await expect(session(() => agent.run(config, ['lab-target']))).rejects.toThrow(
        'owner session',
      );
    }
    await store.saveUser(owner);
  });
});
