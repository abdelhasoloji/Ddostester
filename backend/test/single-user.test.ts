import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { initAuth } from '../src/auth/guard.js';
import { can } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { prepareSingleUser } from '../src/auth/single-user.js';
import { MemoryStore } from '../src/store/memory.js';
import { AgentError } from '../src/agents/types.js';
import { executeCampaign } from '../src/modules/campaigns/runner.js';

// Authorization-path tests must never generate load, even when confirmation is accepted.
vi.mock('../src/modules/campaigns/runner.js', () => ({ executeCampaign: vi.fn() }));
const email = 'owner@lab.test';
const password = 'Q7!unique-Lab-Password';
const secret = 'unit-test-signing-secret-at-least-32-characters';
const env = { USER_MODE: 'single', SINGLE_USER_EMAIL: email, AUTH_JWT_SECRET: secret };
let store: MemoryStore;
let app: FastifyInstance | undefined;
let token: string;
const headers = () => ({ authorization: `Bearer ${token}` });
const campaign = {
  name: 'Simulation',
  target: 'http://127.0.0.1/',
  probeUrl: 'http://127.0.0.1/health',
  vector: 'http-get',
  maxRps: 5,
  concurrency: 2,
  maxDurationSec: 10,
  authorized: true,
};

async function start() {
  const auth = initAuth(env);
  await prepareSingleUser(store, auth, password);
  const built = await buildApp({
    store,
    auth,
    allowedTargets: ['127.0.0.1'],
    logger: false,
    serveStatic: false,
    autoRouteHighRps: false,
    suiteRecovery: false,
  });
  app = built.app;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  expect(login.statusCode).toBe(200);
  token = login.json().token;
  return built;
}
async function create() {
  const result = await app!.inject({
    method: 'POST',
    url: '/api/campaigns',
    headers: headers(),
    payload: campaign,
  });
  expect(result.statusCode).toBe(201);
  return result.json();
}
beforeEach(() => {
  store = new MemoryStore();
  vi.mocked(executeCampaign)
    .mockReset()
    .mockRejectedValue(new AgentError('stub runner: no traffic'));
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('explicit owner migration', () => {
  it('requires an explicit migration before normal startup', async () => {
    await expect(
      buildApp({
        store,
        auth: initAuth(env),
        allowedTargets: ['127.0.0.1'],
        logger: false,
        serveStatic: false,
      }),
    ).rejects.toThrow(/migration required/);
    expect(await store.listUsers()).toEqual([]);
  });
  it('imports env accounts once, preserves other statuses and credentials, and protects one owner', async () => {
    const auth = initAuth({
      ...env,
      AUTH_USERS: JSON.stringify([
        { email, role: 'engineer', passwordHash: hashPassword(password) },
        { email: 'other@lab.test', role: 'admin', passwordHash: hashPassword(password) },
        {
          email: 'disabled@lab.test',
          role: 'viewer',
          status: 'disabled',
          passwordHash: hashPassword(password),
        },
      ]),
    });
    await prepareSingleUser(store, auth);
    expect((await store.getUser(email))!.role).toBe('admin');
    expect((await store.getUser('other@lab.test'))!.role).toBe('viewer');
    expect((await store.getUser('other@lab.test'))!.status).not.toBe('disabled');
    expect((await store.getUser('disabled@lab.test'))!.status).toBe('disabled');
    expect(verifyPassword(password, (await store.getUser('other@lab.test'))!.passwordHash)).toBe(
      true,
    );
    expect(auth.users.size).toBe(0);
    expect((await store.getAccountPolicy())!.primaryAdminEmail).toBe(email);
  });
  it('preserves a changed password and token version on migration retry', async () => {
    await prepareSingleUser(store, initAuth(env), password);
    const first = (await store.getUser(email))!;
    const changed = {
      ...first,
      passwordHash: hashPassword('Changed!credential-72'),
      tokenVersion: 7,
    };
    await store.saveUser(changed);
    await prepareSingleUser(store, initAuth(env), password);
    expect(await store.getUser(email)).toEqual(changed);
    expect((await store.listAudit()).filter((a) => a.action === 'user.single_mode')).toHaveLength(
      1,
    );
  });
  it('refuses an unknown selected owner without writes', async () => {
    const old = {
      email: 'other@lab.test',
      role: 'admin' as const,
      passwordHash: hashPassword(password),
    };
    await store.saveUser(old);
    await expect(prepareSingleUser(store, initAuth(env), password)).rejects.toThrow(
      /existing account/,
    );
    expect(await store.getUser(old.email)).toEqual(old);
  });
  it('rolls back users and policy when the transactional audit fails', async () => {
    const audit = vi.spyOn(store, 'saveAudit').mockRejectedValueOnce(new Error('audit failure'));
    await expect(prepareSingleUser(store, initAuth(env), password)).rejects.toThrow(
      /audit failure/,
    );
    expect(await store.listUsers()).toEqual([]);
    expect(await store.getAccountPolicy()).toBeUndefined();
    audit.mockRestore();
  });
  it('defaults to the named owner and does not substitute another admin', async () => {
    expect(initAuth({ AUTH_JWT_SECRET: secret }).singleUserEmail).toBe('abdelha@wedos');
    await store.saveUser({
      email: 'other@lab.test',
      role: 'admin',
      passwordHash: hashPassword(password),
    });
    await expect(prepareSingleUser(store, initAuth({ AUTH_JWT_SECRET: secret }))).rejects.toThrow(
      /existing account/,
    );
  });
});

describe('single administrator API', () => {
  it('grants all capabilities only to the single admin and preserves team roles', () => {
    for (const perm of [
      'campaign:create',
      'campaign:approve',
      'campaign:execute',
      'target:authorize',
      'bench:dispatch',
      'limits:manage',
    ] as const) {
      expect(can('admin', perm, 'single')).toBe(true);
      expect(can('viewer', perm, 'single')).toBe(false);
    }
    expect(can('admin', 'campaign:execute')).toBe(true);
    expect(can('engineer', 'campaign:approve')).toBe(false);
  });
  it('manages other profiles while refusing a second admin or owner demotion', async () => {
    await start();
    const create = await app!.inject({
      method: 'POST',
      url: '/api/users',
      headers: headers(),
      payload: { email: 'extra@lab.test', role: 'viewer', password },
    });
    expect(create.statusCode).toBe(201);
    expect((await app!.inject({ url: '/api/users', headers: headers() })).json()).toHaveLength(2);
    const admin = await app!.inject({
      method: 'POST',
      url: '/api/users',
      headers: headers(),
      payload: { email: 'second@lab.test', role: 'admin', password },
    });
    expect(admin.statusCode).toBe(400);
    expect(
      (
        await app!.inject({
          method: 'PATCH',
          url: `/api/users/${email}`,
          headers: headers(),
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app!.inject({ method: 'DELETE', url: `/api/users/${email}`, headers: headers() }))
        .statusCode,
    ).toBe(400);
  });
  it('publishes effective capabilities and per-profile workflow policy', async () => {
    await start();
    const me = (await app!.inject({ url: '/api/auth/me', headers: headers() })).json();
    expect(me.capabilities).toContain('campaign:execute');
    expect(me.contractVersion).toBe(1);
    expect(me.approvalPolicy).toBe('confirmation');
    await store.saveUser({
      email: 'viewer@lab.test',
      role: 'viewer',
      passwordHash: hashPassword(password),
    });
    const viewer = await app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'viewer@lab.test', password },
    });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json().capabilities).toEqual(['campaign:read']);
    expect(viewer.json().approvalPolicy).toBe('dual_control');
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/api/campaigns',
          headers: { authorization: `Bearer ${viewer.json().token}` },
          payload: campaign,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('serializes simultaneous attempts to create another administrator', async () => {
    await start();
    const results = await Promise.all(
      ['a', 'b'].map((label) =>
        app!.inject({
          method: 'POST',
          url: '/api/users',
          headers: headers(),
          payload: { email: `${label}@lab.test`, role: 'admin', password },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([400, 400]);
    expect((await store.listUsers()).filter((u) => u.role === 'admin')).toHaveLength(1);
  });
  it('retains other profiles and rejects stale tokens and share tokens on guarded and report routes', async () => {
    await store.saveUser({
      email: 'other@lab.test',
      role: 'admin',
      passwordHash: hashPassword(password),
    });
    await store.saveUser({ email, role: 'engineer', passwordHash: hashPassword(password) });
    const oldToken = signJwt({ sub: email, role: 'engineer', ver: 0 }, secret);
    await start();
    const bad = await app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'other@lab.test', password },
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().role).toBe('viewer');
    for (const invalid of [
      oldToken,
      signJwt({ sub: 'other@lab.test', role: 'admin' }, secret),
      signJwt({ sub: 'share:x', role: 'viewer' }, secret),
    ]) {
      expect(
        (
          await app!.inject({
            url: '/api/campaigns',
            headers: { authorization: `Bearer ${invalid}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await app!.inject({ url: `/api/runs/missing/report?token=${invalid}` })).statusCode,
      ).toBe(401);
    }
  });
  it('password changes and logout revoke report and API sessions', async () => {
    await start();
    const old = token;
    const changed = await app!.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: headers(),
      payload: { currentPassword: password, newPassword: 'New!strong-Credential73' },
    });
    expect(changed.statusCode).toBe(200);
    expect((await app!.inject({ url: `/api/runs/missing/report?token=${old}` })).statusCode).toBe(
      401,
    );
    token = changed.json().token;
    expect((await app!.inject({ url: '/api/auth/me', headers: headers() })).statusCode).toBe(200);
    expect(
      (await app!.inject({ method: 'POST', url: '/api/auth/logout', headers: headers() }))
        .statusCode,
    ).toBe(200);
    expect((await app!.inject({ url: '/api/auth/me', headers: headers() })).statusCode).toBe(401);
  });
  it('revokes another profile sessions and rotates the owner session explicitly', async () => {
    await start();
    await store.saveUser({
      email: 'viewer@lab.test',
      role: 'viewer',
      passwordHash: hashPassword(password),
    });
    const viewer = await app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'viewer@lab.test', password },
    });
    const old = viewer.json().token;
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/api/users/viewer@lab.test/sessions/revoke',
          headers: headers(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app!.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${old}` } }))
        .statusCode,
    ).toBe(401);
    const ownOld = token;
    const rotate = await app!.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke',
      headers: headers(),
    });
    expect(rotate.statusCode).toBe(200);
    token = rotate.json().token;
    expect((await app!.inject({ url: '/api/auth/me', headers: headers() })).statusCode).toBe(200);
    expect(
      (await app!.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${ownOld}` } }))
        .statusCode,
    ).toBe(401);
  });
  it('does not commit a profile change when its audit cannot be written', async () => {
    await start();
    await store.saveUser({
      email: 'viewer@lab.test',
      role: 'viewer',
      passwordHash: hashPassword(password),
      tokenVersion: 2,
    });
    const before = (await store.getUser('viewer@lab.test'))!;
    const audit = vi
      .spyOn(store, 'saveAudit')
      .mockRejectedValueOnce(new Error('audit unavailable'));
    const update = await app!.inject({
      method: 'PATCH',
      url: '/api/users/viewer@lab.test',
      headers: headers(),
      payload: { role: 'engineer' },
    });
    expect(update.statusCode).toBe(500);
    expect(await store.getUser('viewer@lab.test')).toEqual(before);
    audit.mockRestore();
  });
  it('requires explicit confirmation and launches a pending self-authored campaign through the mocked runner', async () => {
    await start();
    const c = await create();
    expect(c.createdBy).toBe(email);
    expect(c.status).toBe('PENDING_APPROVAL');
    const unconfirmed = await app!.inject({
      method: 'POST',
      url: `/api/campaigns/${c.id}/execute`,
      headers: headers(),
    });
    expect(unconfirmed.json().code).toBe('confirmation_required');
    expect(executeCampaign).not.toHaveBeenCalled();
    const confirmed = await app!.inject({
      method: 'POST',
      url: `/api/campaigns/${c.id}/execute`,
      headers: headers(),
      payload: { confirmed: true },
    });
    expect(confirmed.statusCode).toBe(503); // Expected stub failure, not real load.
    expect(executeCampaign).toHaveBeenCalledOnce();
    expect((await store.listAudit()).some((a) => a.action === 'campaign.confirm')).toBe(true);
  });
  it('still enforces immutable caps and current operational limits before launch', async () => {
    await start();
    const c = await create();
    const over = await app!.inject({
      method: 'PUT',
      url: '/api/limits',
      headers: headers(),
      payload: { maxRps: 2001, maxConcurrency: 500, maxDurationSec: 900 },
    });
    expect(over.statusCode).toBe(400);
    expect(
      (
        await app!.inject({
          method: 'PUT',
          url: '/api/limits',
          headers: headers(),
          payload: { maxRps: 2, maxConcurrency: 2, maxDurationSec: 10 },
        })
      ).statusCode,
    ).toBe(200);
    const result = await app!.inject({
      method: 'POST',
      url: `/api/campaigns/${c.id}/execute`,
      headers: headers(),
      payload: { confirmed: true },
    });
    expect(result.statusCode).toBe(400);
    expect(executeCampaign).not.toHaveBeenCalled();
    expect((await store.getCampaign(c.id))!.status).toBe('PENDING_APPROVAL');
  });
  it('allows explicit self-authorization of an attested target', async () => {
    await start();
    const registered = await app!.inject({
      method: 'POST',
      url: '/api/targets',
      headers: headers(),
      payload: {
        host: 'target.lab.test',
        attestation: 'Dedicated laboratory target owned by the operator',
      },
    });
    expect(registered.statusCode).toBe(201);
    const allowed = await app!.inject({
      method: 'POST',
      url: `/api/targets/${registered.json().id}/authorize`,
      headers: headers(),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().authorizedBy).toBe(email);
  });
  it('requires confirmation for suites and validates all steps before changing them', async () => {
    await start();
    const c = await create();
    await store.saveCampaign({ ...c, suiteId: 'suite-one', suiteOrder: 0 });
    const r = await app!.inject({
      method: 'POST',
      url: '/api/suites/suite-one/run',
      headers: headers(),
    });
    expect(r.json().code).toBe('confirmation_required');
    expect(executeCampaign).not.toHaveBeenCalled();
    const confirmed = await app!.inject({
      method: 'POST',
      url: '/api/suites/suite-one/run',
      headers: headers(),
      payload: { confirmed: true },
    });
    expect(confirmed.statusCode).toBe(202);
    await vi.waitFor(() => expect(executeCampaign).toHaveBeenCalledOnce());
  });
});
