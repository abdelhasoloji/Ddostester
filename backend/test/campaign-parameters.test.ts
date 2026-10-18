import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { parameterBudget } from '../src/modules/campaigns/parameter-budget.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import type { FastifyInstance } from 'fastify';
import { executeCampaign } from '../src/modules/campaigns/runner.js';
vi.mock('../src/modules/campaigns/runner.js', () => ({ executeCampaign: vi.fn() }));
let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    const sequences = (await app.inject({ method: 'GET', url: '/api/suites/sequences' })).json()
      .sequences;
    for (const id of Object.keys(sequences ?? {}))
      await app.inject({ method: 'POST', url: `/api/suites/${id}/cancel` });
  }
  await app?.close();
  app = undefined;
});
async function fixture(scenario = false) {
  const store = new MemoryStore();
  await store.setLimits({ maxRps: 20, maxConcurrency: 5, maxDurationSec: 15 });
  app = (
    await buildApp({
      store,
      auth: initAuth({ USER_MODE: 'team' }),
      logger: false,
      serveStatic: false,
      allowedTargets: ['127.0.0.1'],
      suiteRecovery: false,
      autoRouteHighRps: false,
    })
  ).app;
  const c = (
    await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: {
        name: 'Editable',
        createdBy: 'fixture',
        target: 'http://127.0.0.1/',
        probeUrl: 'http://127.0.0.1/',
        vector: 'http-get',
        maxRps: 5,
        concurrency: 2,
        maxDurationSec: 2,
        authorized: true,
        ...(scenario
          ? {
              scenario: [
                { maxRps: 5, durationSec: 1 },
                { maxRps: 3, durationSec: 1 },
              ],
            }
          : {}),
      },
    })
  ).json();
  await store.saveCampaign({
    ...c,
    status: 'APPROVED',
    approvedBy: 'reviewer',
    cisoApprovedBy: 'reviewer',
    cisoApprovedAt: '2026-01-01T00:00:00Z',
  });
  const state = (
    await app.inject({ method: 'GET', url: `/api/campaigns/${c.id}/parameters` })
  ).json();
  return {
    store,
    c,
    state,
    update: (body: object) =>
      app!.inject({
        method: 'POST',
        url: `/api/campaigns/${c.id}/parameters`,
        payload: {
          revision: state.revision,
          maxRps: 4,
          concurrency: 2,
          maxDurationSec: 2,
          ...body,
        },
      }),
  };
}
describe('Governed pre-step parameter editing', () => {
  it('returns current operational bounds, invalidates approval and records before/after atomically', async () => {
    const f = await fixture();
    expect(f.state.limits).toEqual({ maxRps: 20, maxConcurrency: 5, maxDurationSec: 15 });
    const result = await f.update({});
    expect(result.statusCode).toBe(200);
    expect(result.json().approvedBy).toBeUndefined();
    expect(result.json().cisoApprovedBy).toBeUndefined();
    expect(result.json()).toMatchObject({
      id: f.c.id,
      status: 'PENDING_APPROVAL',
      maxRps: 4,
      target: f.c.target,
    });
    const audit = await f.store.listAudit();
    expect(
      audit.some((e) => e.action === 'campaign.update' && e.detail?.includes('"before"')),
    ).toBe(true);
    expect((await f.update({ maxRps: 3 })).statusCode).toBe(409);
  });
  it('rejects ceilings, malformed values and attempts to change targets or stops', async () => {
    const f = await fixture();
    for (const body of [
      { maxRps: 21 },
      { concurrency: 6 },
      { maxDurationSec: 16 },
      { maxRps: 0 },
      { maxRps: 2.5 },
      { target: 'http://elsewhere/' },
      { authorized: false },
    ])
      expect((await f.update(body)).statusCode).toBe(400);
    expect((await f.store.getCampaign(f.c.id))?.maxRps).toBe(5);
  });
  it('preserves phases and validates their peak and total before saving', async () => {
    const f = await fixture(true);
    expect((await f.update({ scenario: [{ maxRps: 4, durationSec: 1 }] })).statusCode).toBe(400);
    expect(
      (
        await f.update({
          scenario: [
            { maxRps: 4, durationSec: 1 },
            { maxRps: 3, durationSec: 2 },
          ],
        })
      ).statusCode,
    ).toBe(400);
    const result = await f.update({
      scenario: [
        { maxRps: 4, durationSec: 1 },
        { maxRps: 3, durationSec: 1 },
      ],
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().scenario).toHaveLength(2);
  });
  it('refuses historical, frozen and running campaigns', async () => {
    const f = await fixture();
    for (const patch of [
      { status: 'RUNNING' },
      { runId: 'retained-run' },
      { drsDocument: { currentRevision: 1, revisions: [] } },
    ]) {
      const c = { ...f.c, ...patch };
      await f.store.saveCampaign(c);
      const revision = (await import('../src/modules/campaigns/parameters.js')).parameterRevision(
        c,
      );
      expect((await f.update({ revision })).statusCode).toBe(400);
    }
  });
});

it('holds between steps, edits only while idle, and requires renewed approval before resume', async () => {
  vi.mocked(executeCampaign).mockReset().mockRejectedValue(new Error('fixture runner: no traffic'));
  const f = await fixture();
  const first = {
    ...f.c,
    suiteId: 'review-sequence',
    suiteOrder: 0,
    status: 'APPROVED' as const,
    approvedBy: 'reviewer',
  };
  const second = { ...first, id: 'next-step', name: 'Next step', suiteOrder: 1 };
  await f.store.saveCampaign(first);
  await f.store.saveCampaign(second);
  const start = await app!.inject({
    method: 'POST',
    url: '/api/suites/review-sequence/run',
    payload: { pauseBetweenSteps: true },
  });
  expect(start.statusCode).toBe(202);
  await vi.waitFor(async () => {
    const state = (await app!.inject({ method: 'GET', url: '/api/suites/sequences' })).json()
      .sequences['review-sequence'];
    expect(state).toMatchObject({ paused: true, started: 1, pauseBetweenSteps: true });
  });
  expect(vi.mocked(executeCampaign)).toHaveBeenCalledTimes(1);
  const next = (
    await app!.inject({ method: 'GET', url: '/api/campaigns/next-step/parameters' })
  ).json();
  const edit = await app!.inject({
    method: 'POST',
    url: '/api/campaigns/next-step/parameters',
    payload: { revision: next.revision, maxRps: 3, concurrency: 1, maxDurationSec: 1 },
  });
  expect(edit.statusCode).toBe(200);
  expect(edit.json().approvedBy).toBeUndefined();
  expect(
    (await app!.inject({ method: 'POST', url: '/api/suites/review-sequence/resume' })).statusCode,
  ).toBe(409);
  expect(vi.mocked(executeCampaign)).toHaveBeenCalledTimes(1);
  await f.store.saveCampaign({ ...edit.json(), status: 'APPROVED', approvedBy: 'other-reviewer' });
  expect(
    (await app!.inject({ method: 'POST', url: '/api/suites/review-sequence/resume' })).statusCode,
  ).toBe(200);
  await vi.waitFor(() => expect(vi.mocked(executeCampaign)).toHaveBeenCalledTimes(2));
  expect(vi.mocked(executeCampaign).mock.calls[1][0]).toMatchObject({
    maxRps: 3,
    concurrency: 1,
    maxDurationSec: 1,
  });
});

it('requires explicit single-owner confirmation for modified steps at resume', async () => {
  const { prepareSingleUser } = await import('../src/auth/single-user.js');
  const { signJwt } = await import('../src/auth/jwt.js');
  const { AgentError } = await import('../src/agents/types.js');
  vi.mocked(executeCampaign).mockReset().mockRejectedValue(new AgentError('fixture: no traffic'));
  const f = await fixture();
  await app!.close();
  const secret = 'fixture-parameter-signing-secret-32-characters';
  const auth = initAuth({
    USER_MODE: 'single',
    SINGLE_USER_EMAIL: 'owner@fixture.test',
    AUTH_JWT_SECRET: secret,
  });
  await prepareSingleUser(f.store, auth, 'Strong!fixture-password-2026');
  app = (
    await buildApp({
      store: f.store,
      auth,
      logger: false,
      serveStatic: false,
      allowedTargets: ['127.0.0.1'],
      suiteRecovery: false,
      autoRouteHighRps: false,
    })
  ).app;
  const headers = {
    authorization: `Bearer ${signJwt({ sub: 'owner@fixture.test', role: 'admin', ver: (await f.store.getUser('owner@fixture.test'))?.tokenVersion }, secret)}`,
  };
  const first = {
    ...f.c,
    suiteId: 'owner-review',
    suiteOrder: 0,
    status: 'APPROVED' as const,
    approvedBy: 'owner@fixture.test',
  };
  await f.store.saveCampaign(first);
  await f.store.saveCampaign({ ...first, id: 'owner-next', suiteOrder: 1 });
  const request = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app!.inject({ method, url, payload, headers });
  expect(
    (
      await request('POST', '/api/suites/owner-review/run', {
        confirmed: true,
        pauseBetweenSteps: true,
      })
    ).statusCode,
  ).toBe(202);
  try {
    await vi.waitFor(async () =>
      expect(
        (await request('GET', '/api/suites/sequences')).json().sequences['owner-review']?.paused,
      ).toBe(true),
    );
    const state = (await request('GET', '/api/campaigns/owner-next/parameters')).json();
    expect(
      (
        await request('POST', '/api/campaigns/owner-next/parameters', {
          revision: state.revision,
          maxRps: 2,
          concurrency: 1,
          maxDurationSec: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect((await request('POST', '/api/suites/owner-review/resume')).statusCode).toBe(400);
    expect((await f.store.getCampaign('owner-next'))?.status).toBe('PENDING_APPROVAL');
    expect(
      (
        await request('POST', '/api/suites/owner-review/resume', {
          confirmed: true,
          reviewedSteps: [
            { ...parameterBudget((await f.store.getCampaign('owner-next'))!), maxRps: 3 },
          ],
        })
      ).statusCode,
    ).toBe(409);
    expect((await f.store.getCampaign('owner-next'))?.status).toBe('PENDING_APPROVAL');

    expect(
      (
        await request('POST', '/api/suites/owner-review/resume', {
          confirmed: true,
          reviewedSteps: [parameterBudget((await f.store.getCampaign('owner-next'))!)],
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(() => expect(vi.mocked(executeCampaign)).toHaveBeenCalledTimes(2));
  } finally {
    await request('POST', '/api/suites/owner-review/cancel');
  }
});

it('rolls back parameter changes when the audit receipt fails', async () => {
  const f = await fixture();
  const audit = vi
    .spyOn(f.store, 'saveAudit')
    .mockRejectedValueOnce(new Error('audit unavailable'));
  try {
    expect((await f.update({})).statusCode).toBe(500);
    expect(await f.store.getCampaign(f.c.id)).toMatchObject({
      maxRps: 5,
      status: 'APPROVED',
      approvedBy: 'reviewer',
    });
  } finally {
    audit.mockRestore();
  }
});

it('restricts edits to campaign authorship capability', async () => {
  const { signJwt } = await import('../src/auth/jwt.js');
  const f = await fixture();
  await app!.close();
  const secret = 'fixture-parameter-authority-secret-at-least-32';
  const auth = initAuth({
    USER_MODE: 'team',
    AUTH_JWT_SECRET: secret,
    AUTH_USERS: JSON.stringify([
      { email: 'reader@fixture.test', role: 'viewer', passwordHash: 'fixture-unused' },
      { email: 'reviewer@fixture.test', role: 'ciso', passwordHash: 'fixture-unused' },
    ]),
  });
  app = (
    await buildApp({
      store: f.store,
      auth,
      logger: false,
      serveStatic: false,
      allowedTargets: ['127.0.0.1'],
    })
  ).app;
  for (const [email, role] of [
    ['reader@fixture.test', 'viewer'],
    ['reviewer@fixture.test', 'ciso'],
  ]) {
    const token = signJwt({ sub: email, role }, secret);
    const response = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${f.c.id}/parameters`,
      headers: { authorization: `Bearer ${token}` },
      payload: { revision: f.state.revision, maxRps: 2, concurrency: 1, maxDurationSec: 1 },
    });
    expect(response.statusCode).toBe(403);
  }
  expect(
    (await app.inject({ method: 'POST', url: `/api/campaigns/${f.c.id}/parameters`, payload: {} }))
      .statusCode,
  ).toBe(401);
});
