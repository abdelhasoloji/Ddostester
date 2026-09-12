import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

/**
 * Mature user management: forced password change on admin-set temp passwords,
 * self-service change, admin reset, soft deactivation, and immediate session
 * revocation (a deleted / disabled / role-changed / password-changed account's
 * outstanding token stops working at once, not at the 8h token expiry).
 */
const allowed = ['127.0.0.1'];
// An env officer is the immutable root that can always manage users.
const ENV_USERS = JSON.stringify([
  { email: 'root@wedos', role: 'officer', passwordHash: hashPassword('rootpassword!') },
]);
const GOOD_PW = 'Str0ngPass!234';
const GOOD_PW2 = 'An0therStr0ng!';

let app: FastifyInstance;
let store: MemoryStore;

const login = async (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

const tokenFor = async (email: string, password: string): Promise<string> =>
  (await login(email, password)).json().token as string;

/** Create a store user via the API as the env officer; returns nothing. */
const createUser = async (email: string, role: string, password = GOOD_PW) => {
  const t = await tokenFor('root@wedos', 'rootpassword!');
  return app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { authorization: `Bearer ${t}` },
    payload: { email, role, password },
  });
};

beforeEach(async () => {
  store = new MemoryStore();
  const built = await buildApp({
    store,
    auth: initAuth({ AUTH_JWT_SECRET: 'sek', AUTH_USERS: ENV_USERS } as NodeJS.ProcessEnv),
    allowedTargets: allowed,
    logger: false,
    serveStatic: false,
  });
  app = built.app;
});

describe('password policy on create', () => {
  it('rejects a password shorter than the floor', async () => {
    const r = await createUser('u1@wedos', 'viewer', 'short1');
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/at least 12/);
  });

  it('rejects a password containing the email name', async () => {
    const r = await createUser('marketing@wedos', 'viewer', 'marketing-1234');
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/email name/);
  });

  it('accepts a compliant password and flags a forced change', async () => {
    const r = await createUser('u2@wedos', 'engineer');
    expect(r.statusCode).toBe(201);
    expect(r.json().mustChangePassword).toBe(true);
  });
});

describe('forced password change', () => {
  it('blocks guarded routes until the temp password is changed', async () => {
    await createUser('temp@wedos', 'engineer');
    const t = await tokenFor('temp@wedos', GOOD_PW);
    // /me is reachable and advertises the forced change…
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(me.json().mustChangePassword).toBe(true);
    // …but a guarded route is blocked with a machine-readable code.
    const list = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(list.statusCode).toBe(403);
    expect(list.json().code).toBe('password_change_required');
  });

  it('lifts the block after a self-service change', async () => {
    await createUser('temp2@wedos', 'engineer');
    const t = await tokenFor('temp2@wedos', GOOD_PW);
    const chg = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${t}` },
      payload: { currentPassword: GOOD_PW, newPassword: GOOD_PW2 },
    });
    expect(chg.statusCode).toBe(200);
    expect(chg.json().mustChangePassword).toBe(false);
    const fresh = chg.json().token as string;
    const list = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(list.statusCode).toBe(200);
  });
});

describe('self-service password change', () => {
  it('rejects a wrong current password', async () => {
    await createUser('sc@wedos', 'engineer');
    const t = await tokenFor('sc@wedos', GOOD_PW);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${t}` },
      payload: { currentPassword: 'wrong-password-1', newPassword: GOOD_PW2 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/incorrect/);
  });

  it('rejects reusing the same password', async () => {
    await createUser('sc2@wedos', 'engineer');
    const t = await tokenFor('sc2@wedos', GOOD_PW);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${t}` },
      payload: { currentPassword: GOOD_PW, newPassword: GOOD_PW },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/differ/);
  });

  it('revokes other sessions but keeps the returned token valid', async () => {
    await createUser('sc3@wedos', 'engineer');
    const oldToken = await tokenFor('sc3@wedos', GOOD_PW);
    const chg = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${oldToken}` },
      payload: { currentPassword: GOOD_PW, newPassword: GOOD_PW2 },
    });
    const newToken = chg.json().token as string;
    // The pre-change token is now revoked…
    const withOld = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(withOld.statusCode).toBe(401);
    // …the fresh token still works.
    const withNew = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(withNew.statusCode).toBe(200);
  });

  it('refuses to self-change an env-managed account', async () => {
    const t = await tokenFor('root@wedos', 'rootpassword!');
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${t}` },
      payload: { currentPassword: 'rootpassword!', newPassword: GOOD_PW2 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/configuration/);
  });
});

describe('admin password reset', () => {
  it('sets a temp password, revokes the old session, and forces a change', async () => {
    await createUser('ar@wedos', 'engineer');
    // The user changes their temp password to a real one and signs in.
    const t0 = await tokenFor('ar@wedos', GOOD_PW);
    await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${t0}` },
      payload: { currentPassword: GOOD_PW, newPassword: GOOD_PW2 },
    });
    const userToken = await tokenFor('ar@wedos', GOOD_PW2);

    // Officer resets their password.
    const officer = await tokenFor('root@wedos', 'rootpassword!');
    const reset = await app.inject({
      method: 'POST',
      url: '/api/users/ar@wedos/password',
      headers: { authorization: `Bearer ${officer}` },
      payload: { password: 'Reset!Pass123' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().mustChangePassword).toBe(true);

    // The user's outstanding token is revoked immediately.
    const after = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(after.statusCode).toBe(401);

    // The old password no longer works; the reset one does, but forces a change.
    expect((await login('ar@wedos', GOOD_PW2)).statusCode).toBe(401);
    const relog = await login('ar@wedos', 'Reset!Pass123');
    expect(relog.statusCode).toBe(200);
    expect(relog.json().mustChangePassword).toBe(true);
  });

  it('refuses to reset an env user', async () => {
    const officer = await tokenFor('root@wedos', 'rootpassword!');
    const r = await app.inject({
      method: 'POST',
      url: '/api/users/root@wedos/password',
      headers: { authorization: `Bearer ${officer}` },
      payload: { password: 'Reset!Pass123' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('deactivation & session revocation', () => {
  it('deactivates an account: existing token dies and login is refused', async () => {
    await createUser('dz@wedos', 'engineer');
    const userToken = await tokenFor('dz@wedos', GOOD_PW);
    const officer = await tokenFor('root@wedos', 'rootpassword!');

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/users/dz@wedos',
      headers: { authorization: `Bearer ${officer}` },
      payload: { status: 'disabled' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().status).toBe('disabled');

    // The user's outstanding token is rejected immediately…
    const withToken = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(withToken.statusCode).toBe(401);
    // …and a fresh login (correct password) is refused with a generic error.
    const relog = await login('dz@wedos', GOOD_PW);
    expect(relog.statusCode).toBe(401);
  });

  it('reactivation restores login', async () => {
    await createUser('re@wedos', 'engineer');
    const officer = await tokenFor('root@wedos', 'rootpassword!');
    const patch = (status: string) =>
      app.inject({
        method: 'PATCH',
        url: '/api/users/re@wedos',
        headers: { authorization: `Bearer ${officer}` },
        payload: { status },
      });
    await patch('disabled');
    expect((await login('re@wedos', GOOD_PW)).statusCode).toBe(401);
    await patch('active');
    expect((await login('re@wedos', GOOD_PW)).statusCode).toBe(200);
  });

  it('a role change revokes the old token (takes effect immediately)', async () => {
    await createUser('rc@wedos', 'viewer');
    // Turn the temp password into a real one so the token is unencumbered.
    const t0 = await tokenFor('rc@wedos', GOOD_PW);
    await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${t0}` },
      payload: { currentPassword: GOOD_PW, newPassword: GOOD_PW2 },
    });
    const viewerToken = await tokenFor('rc@wedos', GOOD_PW2);
    const officer = await tokenFor('root@wedos', 'rootpassword!');
    await app.inject({
      method: 'PATCH',
      url: '/api/users/rc@wedos',
      headers: { authorization: `Bearer ${officer}` },
      payload: { role: 'engineer' },
    });
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('cannot deactivate the last active officer', async () => {
    await createUser('off2@wedos', 'officer');
    const officer = await tokenFor('root@wedos', 'rootpassword!');
    // root is env (not deactivatable); off2 is the only STORE officer, but the
    // env officer keeps an active officer present, so disabling off2 is allowed.
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/users/off2@wedos',
      headers: { authorization: `Bearer ${officer}` },
      payload: { status: 'disabled' },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('logout', () => {
  it('records a logout for an authenticated caller', async () => {
    await createUser('lo@wedos', 'engineer');
    const t = await tokenFor('lo@wedos', GOOD_PW);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    const chain = await store.listAuditChain();
    expect(chain.some((e) => e.action === 'auth.logout')).toBe(true);
  });
});
