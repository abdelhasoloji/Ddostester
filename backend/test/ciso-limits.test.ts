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

describe('CISO role (RBAC)', () => {
  it('is the only role that can manage limits, and is not an operator', () => {
    expect(isRole('ciso')).toBe(true);
    expect(can('ciso', 'limits:manage')).toBe(true);
    // Governance, not operations: the CISO cannot create/approve/execute.
    expect(can('ciso', 'campaign:create')).toBe(false);
    expect(can('ciso', 'campaign:approve')).toBe(false);
    expect(can('ciso', 'campaign:execute')).toBe(false);
    // The CISO can read and emergency-kill.
    expect(can('ciso', 'campaign:read')).toBe(true);
    expect(can('ciso', 'campaign:kill')).toBe(true);
    // No other role can manage limits.
    for (const r of ['officer', 'engineer', 'viewer'] as const) {
      expect(can(r, 'limits:manage'), r).toBe(false);
    }
  });
});

describe('CISO-managed operational limits (PUT /api/limits)', () => {
  let app: FastifyInstance;
  let ciso = '';
  let officer = '';
  let engineer = '';

  beforeAll(async () => {
    const AUTH_USERS = JSON.stringify([
      { email: 'ciso@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-1234') },
      { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('pw-officer-123') },
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
    ciso = await login(app, 'ciso@wedos', 'pw-ciso-1234');
    officer = await login(app, 'off@wedos', 'pw-officer-123');
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

  it('lets the CISO tighten the operational limits, and audits the change', async () => {
    const r = await putLimits(ciso, { maxRps: 100, maxConcurrency: 50, maxDurationSec: 120 });
    expect(r.statusCode).toBe(200);
    expect(r.json().effective).toEqual({ maxRps: 100, maxConcurrency: 50, maxDurationSec: 120 });
    // /health now reports the tightened effective caps (the frontend reads these).
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
      headers: { authorization: `Bearer ${ciso}` },
    });
    expect(JSON.stringify(audit.json())).toContain('limits.update');
  });

  it('enforces the tightened operational limit on new campaigns', async () => {
    // With operational maxRps=100 (set above), a 500-rps campaign is rejected…
    const tooHigh = await createCampaign(engineer, 500);
    expect(tooHigh.statusCode).toBe(400);
    expect(tooHigh.json().error).toMatch(/maxRps/);
    // …while one within the operational limit is accepted.
    const ok = await createCampaign(engineer, 100);
    expect(ok.statusCode).toBe(201);
  });

  it('never lets a limit exceed the immutable ceiling (400)', async () => {
    const overCeiling = await putLimits(ciso, {
      maxRps: 999_999,
      maxConcurrency: 50,
      maxDurationSec: 120,
    });
    expect(overCeiling.statusCode).toBe(400);
    // Non-integer / below 1 is rejected too.
    expect(
      (await putLimits(ciso, { maxRps: 0, maxConcurrency: 50, maxDurationSec: 120 })).statusCode,
    ).toBe(400);
  });

  it('is CISO-only: officer and engineer are forbidden (403)', async () => {
    const body = { maxRps: 200, maxConcurrency: 50, maxDurationSec: 120 };
    expect((await putLimits(officer, body)).statusCode).toBe(403);
    expect((await putLimits(engineer, body)).statusCode).toBe(403);
  });
});
