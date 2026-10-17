import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { drsSequencePlan, waitForScenarioInterval } from '../src/modules/drs/sequence.js';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
vi.mock('../src/agents/index.js', async (original) => {
  const actual = await original<typeof import('../src/agents/index.js')>();
  return {
    ...actual,
    agentChoices: () => [
      ...actual.agentChoices(),
      {
        id: 'fleet',
        multiPhase: false,
        flowCapable: false,
        endpointCapable: false,
        correlationCapable: false,
      },
    ],
  };
});
let store: MemoryStore;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let headers: { authorization: string };
const body = {
  name: 'DRS campaign',
  targetLevel: 2,
  intervalSec: 12,
  target: 'http://lab-target:8080/',
  probeUrl: 'http://lab-target:8080/health',
  maxRps: 3,
  concurrency: 3,
  maxDurationSec: 20,
  fleetDeviceIds: ['one'],
  authorized: true,
};
beforeEach(async () => {
  store = new MemoryStore();
  vi.stubEnv('CAMPAIGN_CATALOG', 'drs-fleet');
  vi.stubEnv('FLEET_MISSIONS_ENABLED', '0');
  app = (
    await buildApp({
      store,
      allowedTargets: ['lab-target'],
      logger: false,
      serveStatic: false,
      auth: initAuth({
        USER_MODE: 'team',
        AUTH_JWT_SECRET: 'drs-sequence-fixture',
        AUTH_USERS: JSON.stringify([
          { email: 'owner@wedos', role: 'admin', passwordHash: hashPassword('fixture-password') },
          { email: 'viewer@wedos', role: 'viewer', passwordHash: hashPassword('fixture-password') },
        ]),
      } as NodeJS.ProcessEnv),
    })
  ).app;
  vi.stubEnv('FLEET_MISSIONS_ENABLED', '1');
  await store.saveFleetDevice({
    id: 'one',
    agentId: 'one',
    name: 'one',
    group: 'VPS Lab',
    profile: 'sensor',
    privateIp: '10.0.0.1',
    notes: '',
    createdAt: '',
    updatedAt: '',
    credential: { hash: 'private-fixture', expiresAt: Date.now() + 60000 },
    heartbeat: {
      receivedAt: Date.now(),
      sequence: 1,
      version: 'fleet-mission-agent/v1',
      uptimeSec: 1,
      peerIp: '127.0.0.1',
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@wedos', password: 'fixture-password' },
  });
  headers = { authorization: 'Bearer ' + login.json().token };
});
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it('keeps every required reference scenario and never treats executable coverage as a score', () => {
  const p = drsSequencePlan(5, 30);
  expect(p.rows.every((r) => r.level <= 5)).toBe(true);
  expect(p.executable).toBe(5);
  expect(p.blocked).toBeGreaterThan(5);
  expect(p.executable + p.blocked).toBe(p.rows.length);
  expect(p.measuredLevel).toBeNull();
  expect(drsSequencePlan(5, 31).planHash).not.toBe(p.planHash);
  for (const [l, i] of [
    [0, 30],
    [8, 30],
    [5, -1],
    [5, 3601],
    [5, NaN],
    [1.5, 0],
  ])
    expect(() => drsSequencePlan(l, i)).toThrow();
});
it('creates bounded ordered drafts, freezes them together and reports missing vectors', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/drs/sequences',
    headers,
    payload: body,
  });
  expect(created.statusCode).toBe(201);
  const { suiteId, campaigns, plan } = created.json();
  expect(campaigns).toHaveLength(2);
  expect(campaigns.map((c: { suiteOrder: number }) => c.suiteOrder)).toEqual([0, 1]);
  expect(
    campaigns.every(
      (c: { maxRps: number; status: string }) => c.maxRps === 3 && c.status === 'PENDING_APPROVAL',
    ),
  ).toBe(true);
  const before = JSON.stringify(await store.listCampaigns());
  const stale = await app.inject({
    method: 'POST',
    url: `/api/suites/${suiteId}/drs/freeze`,
    headers,
    payload: { planHash: 'stale' },
  });
  expect(stale.statusCode).toBe(409);
  expect(JSON.stringify(await store.listCampaigns())).toBe(before);
  const frozen = await app.inject({
    method: 'POST',
    url: `/api/suites/${suiteId}/drs/freeze`,
    headers,
    payload: { planHash: plan.planHash },
  });
  expect(frozen.statusCode).toBe(200);
  expect(
    frozen
      .json()
      .campaigns.every(
        (c: { drsDocument: { revisions: { planHash?: string }[] } }) =>
          c.drsDocument.revisions[0].planHash,
      ),
  ).toBe(true);
  const report = await app.inject({ url: `/api/suites/${suiteId}/drs/report`, headers });
  expect(report.json()).toMatchObject({
    score: null,
    status: 'PARTIAL',
    targetLevel: 2,
    intervalSec: 12,
  });
  expect(
    report
      .json()
      .rows.filter((r: { supported: boolean; state: string }) => !r.supported)
      .every((r: { state: string }) => r.state === 'NOT_EVALUATED'),
  ).toBe(true);
  const html = await app.inject({ url: `/api/suites/${suiteId}/drs/report?format=html`, headers });
  expect(html.headers['content-type']).toContain('text/html');
  expect(html.body).toContain('no measured DRS score');
  const anonymous = await app.inject({ url: `/api/suites/${suiteId}/drs/report` });
  expect(anonymous.statusCode).toBe(401);
});
it('rejects invalid budgets, unauthorized targets and offline agents without partial drafts', async () => {
  for (const changes of [
    { maxRps: 16 },
    { target: 'http://unauthorized.invalid/' },
    { authorized: false },
    { intervalSec: 3601 },
    { fleetDeviceIds: ['missing'] },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/drs/sequences',
      headers,
      payload: { ...body, ...changes },
    });
    expect(response.statusCode).toBe(400);
    expect(await store.listCampaigns()).toHaveLength(0);
  }
});
it('prevents unreviewed or unfrozen sequence launch and preserves viewer permissions', async () => {
  const created = (
    await app.inject({ method: 'POST', url: '/api/drs/sequences', headers, payload: body })
  ).json();
  for (const payload of [{ confirmed: true }, { confirmed: true, planHash: created.plan.planHash }])
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/suites/${created.suiteId}/run`,
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(409);
  const login = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'viewer@wedos', password: 'fixture-password' },
    })
  ).json();
  const viewer = { authorization: 'Bearer ' + login.token };
  expect(
    (
      await app.inject({
        url: '/api/drs/sequences/plan?targetLevel=5&intervalSec=30',
        headers: viewer,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/drs/sequences',
        headers: viewer,
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
});
it('waits the configured interval, holds a paused sequence and cancels without advancing', async () => {
  let clock = 0;
  const control = {
    paused: false,
    cancelled: false,
    intervalEndsAt: undefined as number | undefined,
  };
  expect(
    await waitForScenarioInterval(control, 2, {
      now: () => clock,
      isStopping: () => false,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
  ).toBe(true);
  expect(clock).toBe(2000);
  expect(control.intervalEndsAt).toBeUndefined();
  clock = 0;
  control.paused = true;
  expect(
    await waitForScenarioInterval(control, 1, {
      now: () => clock,
      isStopping: () => false,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 1400) control.cancelled = true;
      },
    }),
  ).toBe(false);
  expect(clock).toBeGreaterThanOrEqual(1400);
  expect(control.intervalEndsAt).toBeUndefined();
});

it('preserves the saved chain and refuses altered reference rows', async () => {
  const created = (
    await app.inject({ method: 'POST', url: '/api/drs/sequences', headers, payload: body })
  ).json();
  const path = `/api/suites/${created.suiteId}/drs/plan`;
  const saved = await app.inject({ url: path, headers });
  expect(saved.json().planHash).toBe(created.plan.planHash);
  expect(saved.json().rows).toEqual(created.plan.rows);
  const member = (await store.listCampaigns())[0];
  member.drsSequence!.referenceRows[0].name = 'altered';
  await store.saveCampaign(member);
  expect((await app.inject({ url: path, headers })).statusCode).toBe(409);
});
it('resumes only after the minimum interval and never advances during shutdown', async () => {
  let clock = 0;
  const control = { paused: true, cancelled: false };
  const result = await waitForScenarioInterval(control, 1, {
    now: () => clock,
    isStopping: () => false,
    sleep: async (ms) => {
      clock += ms;
      if (clock >= 1400) control.paused = false;
    },
  });
  expect(result).toBe(true);
  expect(clock).toBe(1400);
  const sleep = vi.fn();
  expect(
    await waitForScenarioInterval(control, 5, { now: () => clock, isStopping: () => true, sleep }),
  ).toBe(false);
  expect(sleep).not.toHaveBeenCalled();
});
