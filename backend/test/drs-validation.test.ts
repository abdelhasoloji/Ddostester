import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

const ALLOWED = ['127.0.0.1', 'localhost'];
const LAB = ['lab-target.internal'];

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

describe('DRS validation governance', () => {
  it('fails closed when LAB_TARGETS overlaps ALLOWED_TARGETS', async () => {
    const auth = initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS: '[]' } as NodeJS.ProcessEnv);
    await expect(
      buildApp({
        store: new MemoryStore(),
        auth,
        allowedTargets: ['127.0.0.1'],
        labTargets: ['127.0.0.1'], // overlap → must throw
        logger: false,
        serveStatic: false,
      }),
    ).rejects.toThrow(/overlap/i);
  });

  describe('POST /api/drs-validations', () => {
    let app: FastifyInstance;
    let ciso = '';
    let engineer = '';

    beforeAll(async () => {
      const AUTH_USERS = JSON.stringify([
        { email: 'off@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-123') },
        { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('pw-engineer-123') },
      ]);
      const auth = initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
      app = (
        await buildApp({
          store: new MemoryStore(),
          auth,
          allowedTargets: ALLOWED,
          labTargets: LAB,
          logger: false,
          serveStatic: false,
        })
      ).app;
      ciso = await login(app, 'off@wedos', 'pw-ciso-123');
      engineer = await login(app, 'eng@wedos', 'pw-engineer-123');
    });

    const post = (token: string, body: object): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/api/drs-validations',
        headers: { authorization: `Bearer ${token}` },
        payload: body,
      });

    const valid = {
      technique: 'h2-rapid-reset',
      class: 'B',
      labTarget: 'https://lab-target.internal/',
      outcome: 'MITIGATED',
      detectionSec: 4,
      mitigationSec: 11,
      runner: 'runner-01',
    };

    it('records a valid class-B verdict on a lab target (201) + audits it', async () => {
      const r = await post(ciso, valid);
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ recorded: true, labTarget: 'lab-target.internal' });
      const audit = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { authorization: `Bearer ${ciso}` },
      });
      expect(JSON.stringify(audit.json())).toContain('h2-rapid-reset');
    });

    it('rejects class C (out of scope — network bench)', async () => {
      const r = await post(ciso, { ...valid, class: 'C' });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/class C/i);
    });

    it('rejects a target that is not an isolated lab host', async () => {
      const prod = await post(ciso, { ...valid, labTarget: 'http://127.0.0.1/' });
      expect(prod.statusCode).toBe(400);
      const unknown = await post(ciso, { ...valid, labTarget: 'http://evil.example/' });
      expect(unknown.statusCode).toBe(400);
    });

    it('rejects a bad outcome and a missing technique', async () => {
      expect((await post(ciso, { ...valid, outcome: 'MAYBE' })).statusCode).toBe(400);
      expect((await post(ciso, { ...valid, technique: '' })).statusCode).toBe(400);
    });

    it('is ciso-only (engineer 403)', async () => {
      expect((await post(engineer, valid)).statusCode).toBe(403);
    });
  });

  it('is disabled (400) when no LAB_TARGETS are configured', async () => {
    const AUTH_USERS = JSON.stringify([
      { email: 'off@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-123') },
    ]);
    const auth = initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
    const app = (
      await buildApp({
        store: new MemoryStore(),
        auth,
        allowedTargets: ALLOWED,
        logger: false,
        serveStatic: false,
      })
    ).app;
    const token = await login(app, 'off@wedos', 'pw-ciso-123');
    const r = await app.inject({
      method: 'POST',
      url: '/api/drs-validations',
      headers: { authorization: `Bearer ${token}` },
      payload: { technique: 't', class: 'A', labTarget: 'x', outcome: 'MITIGATED' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/disabled/i);
  });
});
