import { it, expect, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { kills } from '../src/runtime/kills.js';
it('preserves a safe failure reference without leaking the underlying exception or leaving an active run', async () => {
  const store = new MemoryStore();
  const run = vi.fn();
  const agent = {
    name: 'fixture',
    description: 'Failure fixture',
    multiPhase: true,
    flowCapable: false,
    endpointCapable: false,
    correlationCapable: false,
    available: async () => {
      throw new Error('PRIVATE-EXCEPTION-CONTENT');
    },
    run,
  };
  const { app } = await buildApp({
    store,
    agent,
    allowedTargets: ['127.0.0.1'],
    logger: false,
    serveStatic: false,
    auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
  });
  try {
    const campaign = createCampaign(
      {
        name: 'Fixture',
        createdBy: 'owner',
        authorized: true,
        target: 'http://127.0.0.1/',
        probeUrl: 'http://127.0.0.1/',
        vector: 'http-get',
        maxRps: 1,
        concurrency: 1,
        maxDurationSec: 1,
      },
      ['127.0.0.1'],
    );
    await store.saveCampaign({ ...campaign, status: 'APPROVED', approvedBy: 'reviewer' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/campaigns/' + campaign.id + '/execute',
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe('internal error');
    expect(response.json().diagnosticId).toMatch(/^[a-f0-9-]{36}$/);
    const saved = await store.getCampaign(campaign.id);
    expect(saved?.status).toBe('APPROVED');
    expect(saved?.statusDetail).toContain(response.json().diagnosticId);
    expect(saved?.statusDetail).not.toContain('PRIVATE');
    expect(response.body).not.toContain('PRIVATE');
    expect(kills.get(campaign.id)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
