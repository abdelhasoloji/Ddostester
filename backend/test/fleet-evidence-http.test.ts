import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
import { MemoryStore } from '../src/store/memory.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

it('requires authentication and serves a verifiable no-store evidence attachment to a viewer', async () => {
  const store = new MemoryStore();
  const { app } = await buildApp({
    store,
    serveStatic: false,
    logger: false,
    allowedTargets: ['127.0.0.1'],
    auth: initAuth({
      USER_MODE: 'team',
      AUTH_JWT_SECRET: 'testsecret',
      AUTH_USERS: JSON.stringify([
        {
          email: 'reader@wedos',
          role: 'viewer',
          passwordHash: hashPassword('viewer-password-123'),
        },
      ]),
    }),
  });
  try {
    await store.saveRun({
      runId: 'evidence-run',
      campaignId: 'campaign',
      status: 'COMPLETED',
      generator: {
        config: { headers: { authorization: 'hidden-secret' } },
        fleet: { measurementComplete: false, shards: [] },
        totalRequests: 0,
      },
    } as unknown as CampaignRun);
    const url = '/api/runs/evidence-run/fleet-evidence.json';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/fleet/status' })).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'reader@wedos', password: 'viewer-password-123' },
    });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json().token}` };
    expect(
      (await app.inject({ method: 'GET', url: '/api/fleet/runs/run/evidence.json' })).statusCode,
    ).toBe(401);
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/fleet/runs/invalid%20id/evidence.json',
      headers,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['cache-control']).toBe('no-store');
    expect(
      (await app.inject({ method: 'GET', url: '/api/fleet/campaigns/c/evidence.json' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/fleet/campaigns/invalid%20id/evidence.json',
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const status = await app.inject({ method: 'GET', url: '/api/fleet/status', headers });
    expect(status.statusCode).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(typeof status.json().configured).toBe('boolean');
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.payload).not.toContain('hidden-secret');
    const bundle = response.json();
    expect(createHash('sha256').update(JSON.stringify(bundle.content)).digest('hex')).toBe(
      bundle.sha256,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/api/runs/missing/fleet-evidence.json', headers }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
