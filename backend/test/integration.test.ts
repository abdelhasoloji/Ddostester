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

describe('API — auth désactivée', () => {
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

  it('health : authRequired=false, storage=memory', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.authRequired).toBe(false);
    expect(b.storage).toBe('memory');
  });

  it('crée puis approuve une campagne', async () => {
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

  it('refuse une cible hors allowlist (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: { ...campaignBody, createdBy: 'e', target: 'http://evil.example/' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('404 sur campagne inconnue', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/campaigns/inconnue' });
    expect(r.statusCode).toBe(404);
  });

  it('expose /metrics et /api/audit', async () => {
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.statusCode).toBe(200);
    expect(m.body).toContain('shieldtest_campaigns');
    const au = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(au.statusCode).toBe(200);
    // au moins la création + approbation du test précédent
    expect(au.json().length).toBeGreaterThanOrEqual(2);
  });
});

describe('API — auth + RBAC activées', () => {
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

  it('401 sans token', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(r.statusCode).toBe(401);
  });

  it('login invalide → 401', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'off@wedos', password: 'x' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('verrou anti-brute-force après 5 échecs (429)', async () => {
    const bad = { email: 'lock@wedos', password: 'x' };
    for (let i = 0; i < 5; i++)
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: bad });
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: bad });
    expect(locked.statusCode).toBe(429);
  });

  it('createdBy dérivé du token (anti-usurpation)', async () => {
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

  it('RBAC : engineer ne peut pas approuver (403), officer oui', async () => {
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
