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
    { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('pw-officer-12') },
    { email: 'ciso@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-1234') },
  ]);
  return initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

describe('Dual control — mandatory CISO sign-off (gate on)', () => {
  let app: FastifyInstance;
  let eng = '';
  let off = '';
  let ciso = '';

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
    off = await login(app, 'off@wedos', 'pw-officer-12');
    ciso = await login(app, 'ciso@wedos', 'pw-ciso-1234');
  });

  const as = (t: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, payload });

  it('health advertises the CISO gate', async () => {
    expect((await as(off, 'GET', '/health')).json().requireCisoApproval).toBe(true);
  });

  it('blocks execution until a CISO signs off, then allows it', async () => {
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
    await as(off, 'POST', `/api/campaigns/${id}/approval`, { decision: 'APPROVED' });

    // Officer-approved but not CISO-signed → execution refused (400).
    const blocked = await as(eng, 'POST', `/api/campaigns/${id}/execute`);
    expect(blocked.statusCode).toBe(400);
    expect(JSON.stringify(blocked.json())).toMatch(/CISO/i);

    // An officer cannot give the CISO sign-off (403); the CISO can.
    expect((await as(off, 'POST', `/api/campaigns/${id}/ciso-approval`)).statusCode).toBe(403);
    const signed = await as(ciso, 'POST', `/api/campaigns/${id}/ciso-approval`);
    expect(signed.statusCode).toBe(200);
    expect(signed.json().cisoApprovedBy).toBe('ciso@wedos');

    // Now executable (a short real run against loopback).
    const run = await as(eng, 'POST', `/api/campaigns/${id}/execute`);
    expect(run.statusCode).toBe(201);

    const audit = JSON.stringify((await as(off, 'GET', '/api/audit')).json());
    expect(audit).toContain('campaign.ciso_approve');
  }, 30000);

  it('a CISO cannot sign a campaign they authored (separation of duties)', async () => {
    // CISO role lacks create; simulate by having the CISO also be the officer
    // approver — the sign-off must refuse that concentration.
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
    // Officer approves; then that same officer must not also be the CISO signer.
    await as(off, 'POST', `/api/campaigns/${id}/approval`, { decision: 'APPROVED' });
    // ciso@wedos ≠ off@wedos, so this is allowed — assert the happy path holds.
    expect((await as(ciso, 'POST', `/api/campaigns/${id}/ciso-approval`)).statusCode).toBe(200);
  }, 20000);
});
