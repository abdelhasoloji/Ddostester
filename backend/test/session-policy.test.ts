import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
import { MemoryStore } from '../src/store/memory.js';
import { SESSION_TTL_SECONDS, signJwt, verifyJwt } from '../src/auth/jwt.js';

it('bounds new bearer and read sessions, refreshes only remaining cookie lifetime, and requires bearer for writes', async () => {
  const auth = initAuth({
    USER_MODE: 'team',
    AUTH_JWT_SECRET: 'session-fixture',
    AUTH_USERS: JSON.stringify([
      { email: 'owner@wedos', role: 'admin', passwordHash: hashPassword('Str0ngSession!234') },
    ]),
  });
  const { app } = await buildApp({
    store: new MemoryStore(),
    auth,
    allowedTargets: ['127.0.0.1'],
    logger: false,
    serveStatic: false,
  });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: '127.0.0.1' },
      payload: { email: 'owner@wedos', password: 'Str0ngSession!234' },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    const payload = verifyJwt(token, auth.secret)!;
    expect(payload.exp - payload.iat).toBe(SESSION_TTL_SECONDS);
    expect(login.headers['set-cookie']).toContain('Max-Age=3600');
    const cookie = `shieldtest_read=${encodeURIComponent(token)}`;
    const denied = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { email: 'new@wedos', role: 'viewer', password: 'Str0ngSession!234' },
    });
    expect(denied.statusCode).toBe(401);
    now += 1800_000;
    const me = await app.inject({
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}`, host: '127.0.0.1' },
    });
    expect(me.statusCode).toBe(200);
    expect(me.headers['set-cookie']).toContain('Max-Age=1800');
    now += 1801_000;
    expect(
      (await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ url: '/api/campaigns', headers: { cookie } })).statusCode).toBe(401);
  } finally {
    clock.mockRestore();
    await app.close();
  }
});

it('keeps already issued long sessions valid until their signed expiry without resetting accounts', () => {
  const legacy = signJwt({ sub: 'legacy@wedos', role: 'viewer', ver: 2 }, 'fixture', 8 * 3600);
  expect(verifyJwt(legacy, 'fixture')?.ver).toBe(2);
  expect(verifyJwt(legacy, 'fixture')!.exp - verifyJwt(legacy, 'fixture')!.iat).toBe(8 * 3600);
});
