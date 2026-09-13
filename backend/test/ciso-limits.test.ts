import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
import { can, isRole } from '../src/auth/rbac.js';

const ALLOWED = ['127.0.0.1', 'localhost'];

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

describe('Admin role (RBAC)', () => {
  it('is the only role that can manage limits, and is not an operator/approver', () => {
    expect(isRole('admin')).toBe(true);
    expect(can('admin', 'limits:manage')).toBe(true);
    expect(can('admin', 'user:manage')).toBe(true);
    // Administration, not operations: the admin cannot create/approve/execute.
    expect(can('admin', 'campaign:create')).toBe(false);
    expect(can('admin', 'campaign:approve')).toBe(false);
    expect(can('admin', 'campaign:execute')).toBe(false);
    // The admin can read and emergency-kill.
    expect(can('admin', 'campaign:read')).toBe(true);
    expect(can('admin', 'campaign:kill')).toBe(true);
    // No other role can manage limits (the CISO governs approval, not the caps).
    for (const r of ['ciso', 'engineer', 'viewer'] as const) {
      expect(can(r, 'limits:manage'), r).toBe(false);
    }
  });
});

describe('Admin-managed operational limits (PUT /api/limits)', () => {
  let app: FastifyInstance;
  let admin = '';
  let ciso = '';
  let engineer = '';

  beforeAll(async () => {
    const AUTH_USERS = JSON.stringify([
      { email: 'admin@wedos', role: 'admin', passwordHash: hashPassword('pw-admin-1234') },
      { email: 'ciso@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-1234') },
      { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('pw-engineer-123') },
    ]);
    const auth = initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
    app = (
      await buildApp({
        store: new MemoryStore(),
        auth,
        allowedTargets: ALLOWED,
        logger: false,
        serveStatic: false,
      })
    ).app;
    admin = await login(app, 'admin@wedos', 'pw-admin-1234');
    ciso = await login(app, 'ciso@wedos', 'pw-ciso-1234');
    engineer = await login(app, 'eng@wedos', 'pw-engineer-123');
  });

  const putLimits = (token: string, body: object): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'PUT',
      url: '/api/limits',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });

  const createCampaign = (token: string, maxRps: number): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'probe',
        target: 'http://127.0.0.1/',
        probeUrl: 'http://127.0.0.1/',
        vector: 'http-get',
        maxRps,
        concurrency: 5,
        maxDurationSec: 10,
        authorized: true,
      },
    });

  it('exposes the ceiling and the effective caps (ceiling by default)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/limits',
      headers: { authorization: `Bearer ${engineer}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().ceiling).toEqual({ maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 });
    expect(r.json().effective).toEqual({ maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 });
  });

  it('lets the admin tighten the operational limits, and audits the change', async () => {
    const r = await putLimits(admin, { maxRps: 100, maxConcurrency: 50, maxDurationSec: 120 });
    expect(r.statusCode).toBe(200);
    expect(r.json().effective).toEqual({ maxRps: 100, maxConcurrency: 50, maxDurationSec: 120 });
    const h = await app.inject({ method: 'GET', url: '/health' });
    expect(h.json().hardCaps).toEqual({ maxRps: 100, maxConcurrency: 50, maxDurationSec: 120 });
    expect(h.json().hardCapsCeiling).toEqual({
      maxRps: 2000,
      maxConcurrency: 500,
      maxDurationSec: 900,
    });
    const audit = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(JSON.stringify(audit.json())).toContain('limits.update');
  });

  it('enforces the tightened operational limit on new campaigns', async () => {
    const tooHigh = await createCampaign(engineer, 500);
    expect(tooHigh.statusCode).toBe(400);
    expect(tooHigh.json().error).toMatch(/maxRps/);
    const ok = await createCampaign(engineer, 100);
    expect(ok.statusCode).toBe(201);
  });

  it('never lets a limit exceed the immutable ceiling (400)', async () => {
    const overCeiling = await putLimits(admin, {
      maxRps: 999_999,
      maxConcurrency: 50,
      maxDurationSec: 120,
    });
    expect(overCeiling.statusCode).toBe(400);
    expect(
      (await putLimits(admin, { maxRps: 0, maxConcurrency: 50, maxDurationSec: 120 })).statusCode,
    ).toBe(400);
  });

  it('is admin-only: CISO and engineer are forbidden (403)', async () => {
    const body = { maxRps: 200, maxConcurrency: 50, maxDurationSec: 120 };
    expect((await putLimits(ciso, body)).statusCode).toBe(403);
    expect((await putLimits(engineer, body)).statusCode).toBe(403);
  });
});
