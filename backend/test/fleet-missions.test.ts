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
    if (id) {
      await pool.query('DELETE FROM fleet_missions_v1 WHERE id=$1', [id]);
      await pool.query('DELETE FROM fleet_shards_v1 WHERE run_id=$1', [id]);
      await pool.query('DELETE FROM fleet_runs_v1 WHERE run_id=$1', [id]);
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
});
