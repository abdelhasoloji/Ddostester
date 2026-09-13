import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

/** Share links: a short-lived, read-only token that authorizes report links only. */
describe('POST /api/share (read-only share links)', () => {
  let app: FastifyInstance;
  let cisoToken = '';

  beforeAll(async () => {
    const AUTH_USERS = JSON.stringify([
      { email: 'off@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-123') },
    ]);
    const auth = initAuth({ AUTH_JWT_SECRET: 'testsecret', AUTH_USERS } as NodeJS.ProcessEnv);
    const built = await buildApp({
      store: new MemoryStore(),
      auth,
      allowedTargets: ['127.0.0.1'],
      logger: false,
      serveStatic: false,
    });
    app = built.app;
    cisoToken = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'off@wedos', password: 'pw-ciso-123' },
      })
    ).json().token;
  });

  it('mints a token that authorizes a read route via ?token=', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/share',
      headers: { authorization: `Bearer ${cisoToken}` },
      payload: { ttlMinutes: 30 },
    });
    expect(res.statusCode).toBe(200);
    const { token, ttlMinutes } = res.json();
    expect(ttlMinutes).toBe(30);
    expect(token).toBeTruthy();

    const report = await app.inject({
      method: 'GET',
      url: `/api/reports/compliance?token=${encodeURIComponent(token)}`,
    });
    expect(report.statusCode).toBe(200);
    expect(report.headers['content-type']).toContain('text/html');
  });

  it('the share token is read-only — it cannot create a campaign', async () => {
    const token = (
      await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: { authorization: `Bearer ${cisoToken}` },
        payload: {},
      })
    ).json().token;
    const create = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'x',
        target: 'http://127.0.0.1/',
        probeUrl: 'http://127.0.0.1/',
        vector: 'http-get',
        maxRps: 10,
        concurrency: 2,
        maxDurationSec: 10,
        authorized: true,
      },
    });
    expect(create.statusCode).toBe(403); // viewer role → no campaign:create
  });

  it('caps the TTL to 7 days', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/share',
      headers: { authorization: `Bearer ${cisoToken}` },
      payload: { ttlMinutes: 999999 },
    });
    expect(res.json().ttlMinutes).toBe(7 * 24 * 60);
  });

  it('requires authentication to mint a link', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/share', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
