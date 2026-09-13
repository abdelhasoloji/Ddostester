import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

const ALLOWED = ['127.0.0.1'];

function buildAuth() {
  const AUTH_USERS = JSON.stringify([
    { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('pw-engineer-1') },
    { email: 'ciso1@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso1-1234') },
    { email: 'ciso2@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso2-1234') },
    { email: 'admin@wedos', role: 'admin', passwordHash: hashPassword('pw-admin-1234') },
  ]);
  return initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

describe('Dual control — mandatory second-CISO sign-off (gate on)', () => {
  let app: FastifyInstance;
  let eng = '';
  let ciso1 = ''; // approver
  let ciso2 = ''; // co-signer
  let admin = '';

  beforeAll(async () => {
    app = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ALLOWED,
        logger: false,
        serveStatic: false,
        requireCisoApproval: true,
      })
    ).app;
    eng = await login(app, 'eng@wedos', 'pw-engineer-1');
    ciso1 = await login(app, 'ciso1@wedos', 'pw-ciso1-1234');
    ciso2 = await login(app, 'ciso2@wedos', 'pw-ciso2-1234');
    admin = await login(app, 'admin@wedos', 'pw-admin-1234');
  });

  const as = (t: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, payload });

  it('health advertises the CISO gate', async () => {
    expect((await as(eng, 'GET', '/health')).json().requireCisoApproval).toBe(true);
  });

  it('blocks execution until a second CISO signs off, then allows it', async () => {
    const created = await as(eng, 'POST', '/api/campaigns', {
      name: 'Dual control',
      target: 'http://127.0.0.1/',
      probeUrl: 'http://127.0.0.1/',
      vector: 'http-get',
      maxRps: 5,
      concurrency: 2,
      maxDurationSec: 1,
      authorized: true,
    });
    const id = created.json().id as string;
    // The CISO approves.
    await as(ciso1, 'POST', `/api/campaigns/${id}/approval`, { decision: 'APPROVED' });

    // Approved but not co-signed → execution refused (400).
    const blocked = await as(eng, 'POST', `/api/campaigns/${id}/execute`);
    expect(blocked.statusCode).toBe(400);
    expect(JSON.stringify(blocked.json())).toMatch(/CISO/i);

    // Neither an engineer nor an admin can give the sign-off (403 — CISO only)…
    expect((await as(eng, 'POST', `/api/campaigns/${id}/ciso-approval`)).statusCode).toBe(403);
    expect((await as(admin, 'POST', `/api/campaigns/${id}/ciso-approval`)).statusCode).toBe(403);
    // …and the CISO who approved cannot also co-sign (separation of duties, 400)…
    expect((await as(ciso1, 'POST', `/api/campaigns/${id}/ciso-approval`)).statusCode).toBe(400);
    // …a DIFFERENT CISO can.
    const signed = await as(ciso2, 'POST', `/api/campaigns/${id}/ciso-approval`);
    expect(signed.statusCode).toBe(200);
    expect(signed.json().cisoApprovedBy).toBe('ciso2@wedos');

    // Now executable (a short real run against loopback).
    const run = await as(eng, 'POST', `/api/campaigns/${id}/execute`);
    expect(run.statusCode).toBe(201);

    const audit = JSON.stringify((await as(eng, 'GET', '/api/audit')).json());
    expect(audit).toContain('campaign.ciso_approve');
  }, 30000);

  it('the approver CISO cannot also co-sign (separation of duties)', async () => {
    const created = await as(eng, 'POST', '/api/campaigns', {
      name: 'SoD',
      target: 'http://127.0.0.1/',
      probeUrl: 'http://127.0.0.1/',
      vector: 'http-get',
      maxRps: 5,
      concurrency: 2,
      maxDurationSec: 1,
      authorized: true,
    });
    const id = created.json().id as string;
    await as(ciso1, 'POST', `/api/campaigns/${id}/approval`, { decision: 'APPROVED' });
    // Same CISO who approved must not also give the dual-control sign-off.
    expect((await as(ciso1, 'POST', `/api/campaigns/${id}/ciso-approval`)).statusCode).toBe(400);
    // A different CISO is accepted.
    expect((await as(ciso2, 'POST', `/api/campaigns/${id}/ciso-approval`)).statusCode).toBe(200);
  }, 20000);
});
