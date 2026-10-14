import { it, expect, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
it('retires every generic creation entry without partial campaigns or target discovery', async () => {
  vi.stubEnv('CAMPAIGN_CATALOG', 'drs-fleet');
  vi.stubEnv('FLEET_MISSIONS_ENABLED', '0');
  const store = new MemoryStore();
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { app } = await buildApp({
    store,
    allowedTargets: ['127.0.0.1'],
    logger: false,
    serveStatic: false,
    auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
  });
  try {
    expect((await app.inject({ url: '/health' })).json().drsWorkflow).toBe(true);
    const catalogue = (await app.inject({ url: '/api/drs/catalog' })).json();
    expect(catalogue.profiles).toHaveLength(131);
    const templates = (await app.inject({ url: '/api/playbooks' })).json();
    expect(templates).toHaveLength(131);
    expect(templates.every((p: { id: string }) => p.id.startsWith('drs-3.00.00-'))).toBe(true);
    for (const url of [
      '/api/playbooks/quick-readiness/instantiate',
      '/api/suites/compose',
      '/api/suites/from-actions',
      '/api/playbooks',
    ])
      expect(
        (await app.inject({ method: 'POST', url, payload: { target: 'http://127.0.0.1/' } }))
          .statusCode,
      ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/campaigns',
          payload: {
            name: 'Legacy',
            target: 'http://127.0.0.1/',
            authorized: true,
            createdBy: 'owner',
            agent: 'builtin',
            vector: 'http-get',
            probeUrl: 'http://127.0.0.1/',
            maxRps: 1,
            concurrency: 1,
            maxDurationSec: 1,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(await store.listCampaigns()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await app.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
