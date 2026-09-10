import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

const allowed = ['127.0.0.1', 'localhost'];
const campaignBody = {
  name: 'Test',
  target: 'http://127.0.0.1/',
  probeUrl: 'http://127.0.0.1/',
  vector: 'http-get',
  maxRps: 20,
  concurrency: 5,
  maxDurationSec: 10,
  authorized: true,
};

describe('API — auth disabled', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const built = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({} as NodeJS.ProcessEnv),
      allowedTargets: allowed,
      logger: false,
      serveStatic: false,
    });
    app = built.app;
  });

  it('health: authRequired=false, storage=memory', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.authRequired).toBe(false);
    expect(b.storage).toBe('memory');
  });

  it('health reports a well-formed build stamp', async () => {
    const b = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(b.version).toBeTruthy();
    expect(typeof b.version.version).toBe('string');
    expect(typeof b.version.build).toBe('string');
    expect(typeof b.version.commit).toBe('string');
  });

  it('sets security headers on responses', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'self'");
  });

  it('readiness probe returns 200 when the store is healthy', async () => {
    const r = await app.inject({ method: 'GET', url: '/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json().ready).toBe(true);
  });

  it('creates then approves a campaign', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: { ...campaignBody, createdBy: 'eng@wedos' },
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().id;
    const a = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/approval`,
      payload: { approvedBy: 'off@wedos', decision: 'APPROVED' },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().status).toBe('APPROVED');
  });

  it('rejects a target outside the allowlist (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: { ...campaignBody, createdBy: 'e', target: 'http://evil.example/' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('archives and un-archives a campaign, auditing both', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: { ...campaignBody, createdBy: 'eng@wedos' },
    });
    const id = c.json().id;

    const arc = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/archive`,
      payload: { archived: true },
    });
    expect(arc.statusCode).toBe(200);
    expect(arc.json().archived).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/campaigns/${id}` })).json().archived).toBe(
      true,
    );

    const restore = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/archive`,
      payload: { archived: false },
    });
    expect(restore.json().archived).toBe(false);

    const audit = (await app.inject({ method: 'GET', url: '/api/audit' })).json();
    expect(audit.some((e: { action: string }) => e.action === 'campaign.archive')).toBe(true);
  });

  it('404 when archiving an unknown campaign', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/campaigns/nope/archive',
      payload: { archived: true },
    });
    expect(r.statusCode).toBe(404);
  });

  it('404 on an unknown campaign', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/campaigns/unknown' });
    expect(r.statusCode).toBe(404);
  });

  it('exposes /metrics and /api/audit', async () => {
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.statusCode).toBe(200);
    expect(m.body).toContain('shieldtest_campaigns');
    const au = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(au.statusCode).toBe(200);
    // at least the create + approve from the previous test
    expect(au.json().length).toBeGreaterThanOrEqual(2);
  });

  it('verifies and exports the tamper-evident audit chain', async () => {
    const v = await app.inject({ method: 'GET', url: '/api/audit/verify' });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ ok: true });
    expect(v.json().count).toBeGreaterThanOrEqual(2);

    const ex = await app.inject({ method: 'GET', url: '/api/audit/export' });
    expect(ex.statusCode).toBe(200);
    expect(ex.headers['content-disposition']).toContain('attachment');
    const doc = ex.json();
    expect(doc.kind).toBe('wedos-shieldtest-audit-export');
    expect(doc.headHash).toBe(v.json().headHash);
    expect(doc.entries.every((e: { hash?: string }) => !!e.hash)).toBe(true);
  });
});

describe('API — concurrency guard', () => {
  it('rejects execution with 429 when at the concurrent-run cap', async () => {
    const { app } = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({} as NodeJS.ProcessEnv),
      allowedTargets: allowed,
      logger: false,
      serveStatic: false,
      maxConcurrentRuns: 0, // nothing may run
    });
    const c = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: { ...campaignBody, createdBy: 'eng@wedos' },
    });
    const id = c.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/approval`,
      payload: { approvedBy: 'off@wedos', decision: 'APPROVED' },
    });
    const run = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/execute` });
    expect(run.statusCode).toBe(429);
    expect(run.json().error).toMatch(/concurrent runs/);
  });
});

describe('API — auth + RBAC enabled', () => {
  let app: FastifyInstance;
  const users = JSON.stringify([
    { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('engpw') },
    { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('offpw') },
  ]);
  const token = async (email: string, password: string): Promise<string> => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    return r.json().token as string;
  };

  beforeAll(async () => {
    const built = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({ AUTH_JWT_SECRET: 'sek', AUTH_USERS: users } as NodeJS.ProcessEnv),
      allowedTargets: allowed,
      logger: false,
      serveStatic: false,
    });
    app = built.app;
  });

  it('401 without a token', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(r.statusCode).toBe(401);
  });

  it('invalid login → 401', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'off@wedos', password: 'x' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('anti-brute-force lock after 5 failures (429)', async () => {
    const bad = { email: 'lock@wedos', password: 'x' };
    for (let i = 0; i < 5; i++)
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: bad });
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: bad });
    expect(locked.statusCode).toBe(429);
  });

  it('createdBy derived from the token (anti-spoofing)', async () => {
    const t = await token('eng@wedos', 'engpw');
    const c = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${t}` },
      payload: { ...campaignBody, createdBy: 'spoof@evil' },
    });
    expect(c.statusCode).toBe(201);
    expect(c.json().createdBy).toBe('eng@wedos');
  });

  it('RBAC: engineer cannot approve (403), officer can', async () => {
    const te = await token('eng@wedos', 'engpw');
    const to = await token('off@wedos', 'offpw');
    const c = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${te}` },
      payload: campaignBody,
    });
    const id = c.json().id;
    const denied = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/approval`,
      headers: { authorization: `Bearer ${te}` },
      payload: { decision: 'APPROVED' },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/approval`,
      headers: { authorization: `Bearer ${to}` },
      payload: { decision: 'APPROVED' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().approvedBy).toBe('off@wedos');
  });
});

describe('API — user management (officer only)', () => {
  let app: FastifyInstance;
  const users = JSON.stringify([
    { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('engpw') },
    { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('offpw') },
  ]);
  const token = async (email: string, password: string): Promise<string> => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    return r.json().token as string;
  };

  beforeAll(async () => {
    const built = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({ AUTH_JWT_SECRET: 'sek', AUTH_USERS: users } as NodeJS.ProcessEnv),
      allowedTargets: allowed,
      logger: false,
      serveStatic: false,
    });
    app = built.app;
  });

  it('non-officer cannot list users (403)', async () => {
    const te = await token('eng@wedos', 'engpw');
    const r = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${te}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('officer creates a store user who can then log in', async () => {
    const to = await token('off@wedos', 'offpw');
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${to}` },
      payload: { email: 'viewer@wedos', role: 'viewer', password: 'viewerpw1' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      email: 'viewer@wedos',
      role: 'viewer',
      source: 'store',
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'viewer@wedos', password: 'viewerpw1' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().role).toBe('viewer');
  });

  it('lists env + store users with source', async () => {
    const to = await token('off@wedos', 'offpw');
    const r = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${to}` },
    });
    expect(r.statusCode).toBe(200);
    const list = r.json() as { email: string; source: string }[];
    expect(list.find((u) => u.email === 'off@wedos')?.source).toBe('env');
    expect(list.find((u) => u.email === 'viewer@wedos')?.source).toBe('store');
  });

  it('cannot delete an env user (400)', async () => {
    const to = await token('off@wedos', 'offpw');
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/users/off@wedos',
      headers: { authorization: `Bearer ${to}` },
    });
    expect(r.statusCode).toBe(400);
  });

  it('deletes a store user, who can no longer log in', async () => {
    const to = await token('off@wedos', 'offpw');
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/users/viewer@wedos',
      headers: { authorization: `Bearer ${to}` },
    });
    expect(del.statusCode).toBe(200);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'viewer@wedos', password: 'viewerpw1' },
    });
    expect(login.statusCode).toBe(401);
  });
});
