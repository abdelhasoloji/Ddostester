import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
let app: FastifyInstance;
let store: MemoryStore;
let headers: { authorization: string };
const device = {
  agentId: 'iot-01',
  name: 'Sensor 01',
  group: 'Lab',
  profile: 'sensor',
  privateIp: '10.247.0.53',
  notes: '',
};
beforeEach(async () => {
  store = new MemoryStore();
  const built = await buildApp({
    store,
    allowedTargets: ['127.0.0.1'],
    logger: false,
    serveStatic: false,
    auth: initAuth({
      USER_MODE: 'team',
      AUTH_JWT_SECRET: 'fleet-test-secret',
      AUTH_USERS: JSON.stringify([
        { email: 'abdelha@wedos', role: 'admin', passwordHash: hashPassword('owner-password') },
        { email: 'view@wedos', role: 'viewer', passwordHash: hashPassword('viewer-password') },
      ]),
    } as NodeJS.ProcessEnv),
  });
  app = built.app;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'abdelha@wedos', password: 'owner-password' },
  });
  headers = { authorization: 'Bearer ' + login.json().token };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});
it('persists create/update/remove and actor-bound audit', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/fleet/devices',
    headers,
    payload: device,
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;
  const updated = await app.inject({
    method: 'PUT',
    url: '/api/fleet/devices/' + id,
    headers,
    payload: { ...device, name: 'Renamed', group: 'Office' },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().createdAt).toBe(created.json().createdAt);
  expect((await store.listFleetDevices())[0].name).toBe('Renamed');
  expect(
    (await store.listAuditChain()).some(
      (e) => e.actor === 'abdelha@wedos' && e.detail?.includes('fleet.device.update'),
    ),
  ).toBe(true);
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/fleet/devices/' + id, headers })).statusCode,
  ).toBe(204);
  expect(await store.listFleetDevices()).toEqual([]);
});
it('rejects public addresses and unknown fields without writes', async () => {
  for (const payload of [
    { ...device, privateIp: '8.8.8.8' },
    { ...device, privateIp: '127.0.0.1' },
    { ...device, privateIp: '10.2.3.999' },
    { ...device, shell: 'x' },
  ])
    expect(
      (await app.inject({ method: 'POST', url: '/api/fleet/devices', headers, payload }))
        .statusCode,
    ).toBe(400);
  expect(await store.listFleetDevices()).toEqual([]);
});
it('serializes duplicate identities and IPs', async () => {
  const results = await Promise.all(
    [1, 2].map(() =>
      app.inject({ method: 'POST', url: '/api/fleet/devices', headers, payload: device }),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/fleet/devices',
        headers,
        payload: { ...device, agentId: 'iot-02' },
      })
    ).statusCode,
  ).toBe(409);
});
it('rolls inventory back if audit fails', async () => {
  vi.spyOn(store, 'saveAudit').mockRejectedValue(new Error('unavailable'));
  expect(
    (await app.inject({ method: 'POST', url: '/api/fleet/devices', headers, payload: device }))
      .statusCode,
  ).toBe(500);
  expect(await store.listFleetDevices()).toEqual([]);
});
it('allows viewer read but refuses writes', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'view@wedos', password: 'viewer-password' },
  });
  const viewer = { authorization: 'Bearer ' + login.json().token };
  expect((await app.inject({ url: '/api/fleet/devices', headers: viewer })).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/fleet/devices',
        headers: viewer,
        payload: device,
      })
    ).statusCode,
  ).toBe(403);
});

it('enrolls one agent, hides credential hashes and rejects replay or excessive heartbeats', async () => {
  const created = (
    await app.inject({ method: 'POST', url: '/api/fleet/devices', headers, payload: device })
  ).json();
  const enrollment = (
    await app.inject({
      method: 'POST',
      url: `/api/fleet/devices/${created.id}/enrollment`,
      headers,
    })
  ).json();
  const agentHeaders = { authorization: 'Bearer ' + enrollment.token };
  const heartbeat = {
    agentId: device.agentId,
    privateIp: device.privateIp,
    sequence: 1,
    version: 'inventory-heartbeat/v1',
    uptimeSec: 1,
  };
  const url = `/api/fleet/devices/${created.id}/heartbeat`;
  expect(
    (await app.inject({ method: 'POST', url, headers: agentHeaders, payload: heartbeat }))
      .statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ method: 'POST', url, headers: agentHeaders, payload: heartbeat }))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: agentHeaders,
        payload: { ...heartbeat, sequence: 2 },
      })
    ).statusCode,
  ).toBe(429);
  const listed = await app.inject({ url: '/api/fleet/devices', headers });
  expect(listed.json().devices[0].connection).toBe('online');
  expect(listed.body).not.toContain(enrollment.token);
  expect(listed.body).not.toContain((await store.listFleetDevices())[0].credential!.hash);
});
it('rotation, revocation and identity edits invalidate the old enrollment', async () => {
  const created = (
    await app.inject({ method: 'POST', url: '/api/fleet/devices', headers, payload: device })
  ).json();
  const url = `/api/fleet/devices/${created.id}`;
  const first = (await app.inject({ method: 'POST', url: url + '/enrollment', headers })).json();
  const second = (await app.inject({ method: 'POST', url: url + '/enrollment', headers })).json();
  const payload = {
    agentId: device.agentId,
    privateIp: device.privateIp,
    sequence: 1,
    version: 'test/v1',
    uptimeSec: 1,
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url + '/heartbeat',
        headers: { authorization: 'Bearer ' + first.token },
        payload,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url + '/heartbeat',
        headers: { authorization: 'Bearer ' + second.token },
        payload,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({ method: 'PUT', url, headers, payload: { ...device, name: 'Renamed' } })
    ).json().connection,
  ).toBe('online');
  await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { ...device, privateIp: '10.247.0.102' },
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url + '/heartbeat',
        headers: { authorization: 'Bearer ' + second.token },
        payload,
      })
    ).statusCode,
  ).toBe(401);
  const third = (await app.inject({ method: 'POST', url: url + '/enrollment', headers })).json();
  expect(
    (await app.inject({ method: 'DELETE', url: url + '/enrollment', headers })).json().connection,
  ).toBe('revoked');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: url + '/heartbeat',
        headers: { authorization: 'Bearer ' + third.token },
        payload,
      })
    ).statusCode,
  ).toBe(401);
});
it('expires presence and credentials without presenting stale samples as online', async () => {
  const created = (
    await app.inject({ method: 'POST', url: '/api/fleet/devices', headers, payload: device })
  ).json();
  await app.inject({ method: 'POST', url: `/api/fleet/devices/${created.id}/enrollment`, headers });
  const saved = (await store.listFleetDevices())[0];
  saved.heartbeat = {
    sequence: 1,
    receivedAt: Date.now() - 31000,
    version: 'test/v1',
    uptimeSec: 1,
    peerIp: '127.0.0.1',
  };
  await store.saveFleetDevice(saved);
  expect(
    (await app.inject({ url: '/api/fleet/devices', headers })).json().devices[0].connection,
  ).toBe('offline');
  saved.credential!.expiresAt = Date.now() - 1;
  await store.saveFleetDevice(saved);
  expect(
    (await app.inject({ url: '/api/fleet/devices', headers })).json().devices[0].connection,
  ).toBe('expired');
});
it('accepts a real isolated heartbeat client and its restart with a persisted sequence', async () => {
  const created = (
    await app.inject({ method: 'POST', url: '/api/fleet/devices', headers, payload: device })
  ).json();
  const enrollment = (
    await app.inject({
      method: 'POST',
      url: `/api/fleet/devices/${created.id}/enrollment`,
      headers,
    })
  ).json();
  const controlUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const directory = await mkdtemp(join(tmpdir(), 'ddostester-heartbeat-'));
  const file = join(directory, 'enrollment.json');
  try {
    await writeFile(file, JSON.stringify({ ...enrollment, controlUrl }), { mode: 0o600 });
    const run = () =>
      new Promise<number | null>((done, reject) => {
        const child = spawn(
          process.execPath,
          [resolve('../scripts/fleet/heartbeat-agent.mjs'), file, '2'],
          { stdio: 'ignore' },
        );
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          done(code);
        });
      });
    expect(await run()).toBe(0);
    expect(await run()).toBe(0);
    expect((await store.listFleetDevices())[0].heartbeat?.sequence).toBe(2);
    expect(JSON.parse(await readFile(file + '.state.json', 'utf8')).sequence).toBe(2);
    expect(
      (await app.inject({ url: '/api/fleet/devices', headers })).json().devices[0].connection,
    ).toBe('online');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

it('allows overlapping pod IPs across sites, rejects same-site collisions and binds credentials to site', async () => {
  const first = (
    await app.inject({
      method: 'POST',
      url: '/api/fleet/devices',
      headers,
      payload: { ...device, siteId: 'site-001' },
    })
  ).json();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/fleet/devices',
        headers,
        payload: { ...device, agentId: 'iot-02', siteId: 'site-002' },
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/fleet/devices',
        headers,
        payload: { ...device, agentId: 'iot-03', siteId: 'site-001' },
      })
    ).statusCode,
  ).toBe(409);
  await app.inject({
    method: 'POST',
    url: '/api/fleet/devices/' + first.id + '/enrollment',
    headers,
  });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/fleet/devices/' + first.id,
        headers,
        payload: { ...device, siteId: 'site-003' },
      })
    ).statusCode,
  ).toBe(200);
  expect((await store.getFleetDevice(first.id))?.credential).toBeUndefined();
});
it('paginates 5000 agents across 100 sites without credential disclosure and rejects overflow', async () => {
  const now = new Date().toISOString();
  for (let i = 0; i < 5000; i++)
    await store.saveFleetDevice({
      ...device,
      id: String(i).padStart(5, '0'),
      agentId: 'iot-' + i,
      siteId: 'site-' + Math.floor(i / 50),
      privateIp: '10.0.0.' + ((i % 50) + 1),
      profile: 'sensor',
      createdAt: now,
      updatedAt: now,
      credential: { hash: '0'.repeat(64), expiresAt: Date.now() + 60000 },
    });
  const page = await app.inject({ url: '/api/fleet/devices?page=50&pageSize=100', headers });
  expect(page.statusCode).toBe(200);
  expect(page.json().total).toBe(5000);
  expect(page.json().devices).toHaveLength(100);
  expect(page.json().devices[0].id).toBe('04900');
  expect(page.body).not.toContain('"hash"');
  const site = await app.inject({ url: '/api/fleet/devices?page=1&siteId=site-99', headers });
  expect(site.json().total).toBe(50);
  const summary = await app.inject({ url: '/api/fleet/sites', headers });
  expect(summary.json().sites).toHaveLength(100);
  expect(summary.json().devices).toBe(5000);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/fleet/devices',
        headers,
        payload: { ...device, agentId: 'overflow', siteId: 'site-0' },
      })
    ).statusCode,
  ).toBe(409);
  expect((await app.inject({ url: '/api/fleet/devices?pageSize=5000', headers })).statusCode).toBe(
    400,
  );
});
it('rejects a 101st site without increasing execution capacity', async () => {
  const now = new Date().toISOString();
  for (let i = 0; i < 100; i++)
    await store.saveFleetDevice({
      ...device,
      id: String(i),
      agentId: 'iot-' + i,
      siteId: 'site-' + i,
      profile: 'sensor',
      createdAt: now,
      updatedAt: now,
    });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/fleet/devices',
        headers,
        payload: { ...device, agentId: 'new', siteId: 'site-100' },
      })
    ).statusCode,
  ).toBe(409);
});
