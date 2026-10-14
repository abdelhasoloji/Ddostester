import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

/**
 * End-to-end governed target-onboarding workflow, driven through the real HTTP
 * routes with two authenticated users against a FAKE site — register, MODIFY,
 * request, authorize, confirm it becomes testable (and appears in the campaign
 * allowlist menu), then REVOKE and confirm it is no longer testable.
 */

const ENV_ALLOW = ['127.0.0.1'];
const FAKE = 'preprod.fake-customer.test';
const FAKE_URL = `http://${FAKE}/`;

function buildAuth() {
  const AUTH_USERS = JSON.stringify([
    { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('pw-engineer-1') },
    { email: 'ciso@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-12345') },
  ]);
  return initAuth({ USER_MODE: 'team', AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

describe('Governed target onboarding — full workflow (fake site)', () => {
  let app: FastifyInstance;
  let eng = '';
  let ciso = '';
  let id = '';

  const as = (
    t: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, payload });

  const allowlist = async (): Promise<string[]> =>
    (await as(eng, 'GET', '/health')).json().allowedTargets;

  const createCampaign = (target: string) =>
    as(eng, 'POST', '/api/campaigns', {
      name: 'workflow probe',
      target,
      probeUrl: target,
      vector: 'http-get',
      maxRps: 5,
      concurrency: 2,
      maxDurationSec: 1,
      authorized: true,
    });

  beforeAll(async () => {
    app = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ENV_ALLOW,
        logger: false,
        serveStatic: false,
      })
    ).app;
    eng = await login(app, 'eng@wedos', 'pw-engineer-1');
    ciso = await login(app, 'ciso@wedos', 'pw-ciso-12345');
  });

  it('1. an engineer registers the fake site (metadata only, unauthorized)', async () => {
    const r = await as(eng, 'POST', '/api/targets', {
      host: FAKE,
      displayName: 'Fake Customer',
      owner: 'noc@fake',
    });
    expect(r.statusCode).toBe(201);
    const t = r.json();
    id = t.id;
    expect(t.host).toBe(FAKE);
    expect(t.authStatus).toBe('unauthorized');
    // Registering grants nothing: the host is not yet testable.
    expect(await allowlist()).not.toContain(FAKE);
  });

  it('2. the engineer MODIFIES its metadata', async () => {
    const r = await as(eng, 'PATCH', `/api/targets/${id}`, {
      displayName: 'Fake Customer — preprod',
      owner: 'soc@fake-customer.test',
      notes: 'ENISA CRA preprod portal (fake)',
    });
    expect(r.statusCode).toBe(200);
    const t = r.json();
    expect(t.displayName).toBe('Fake Customer — preprod');
    expect(t.owner).toBe('soc@fake-customer.test');
    expect(t.authStatus).toBe('unauthorized');
  });

  it('3. the engineer requests authorization with an attestation', async () => {
    const r = await as(eng, 'POST', `/api/targets/${id}/request`, {
      attestation: 'WEDOS is mandated to run bounded resilience tests on this host (signed RoE).',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().authStatus).toBe('requested');
  });

  it('4. role separation: an engineer cannot authorize, a CISO cannot register', async () => {
    expect((await as(eng, 'POST', `/api/targets/${id}/authorize`)).statusCode).toBe(403);
    expect((await as(ciso, 'POST', '/api/targets', { host: 'other.test' })).statusCode).toBe(403);
  });

  it('5. while unauthorized, a campaign against the fake host is rejected', async () => {
    const r = await createCampaign(FAKE_URL);
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toMatch(/allowlist/i);
  });

  it('6. a CISO authorizes it → it enters the effective allowlist (campaign menu)', async () => {
    const r = await as(ciso, 'POST', `/api/targets/${id}/authorize`);
    expect(r.statusCode).toBe(200);
    const t = r.json();
    expect(t.authStatus).toBe('authorized');
    expect(t.authorizedBy).toBe('ciso@wedos');
    // Now testable, and advertised by /health (which the campaign form reads for
    // its "Allowed hosts" menu).
    expect(await allowlist()).toContain(FAKE);
  });

  it('7. an engineer can now create a campaign against the fake host', async () => {
    const r = await createCampaign(FAKE_URL);
    expect(r.statusCode).toBe(201);
    expect(r.json().target).toBe(FAKE_URL);
  });

  it('8. the host of an AUTHORIZED target cannot be silently changed', async () => {
    const r = await as(eng, 'PATCH', `/api/targets/${id}`, { host: 'moved.test' });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toMatch(/revoke/i);
  });

  it('9. a CISO REVOKES it → it leaves the allowlist and is no longer testable', async () => {
    const r = await as(ciso, 'POST', `/api/targets/${id}/revoke`);
    expect(r.statusCode).toBe(200);
    expect(r.json().authStatus).toBe('revoked');
    expect(await allowlist()).not.toContain(FAKE);
    expect((await createCampaign(FAKE_URL)).statusCode).toBe(400);
  });

  it('10. a revoked target can be deleted', async () => {
    expect((await as(eng, 'DELETE', `/api/targets/${id}`)).statusCode).toBe(200);
    expect((await as(eng, 'GET', '/api/targets')).json().targets).toHaveLength(0);
  });
});
