import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { initAuth } from '../src/auth/guard.js';
import { MemoryStore } from '../src/store/memory.js';
import { PLAYBOOKS } from '../src/modules/playbooks/playbooks.js';
import { describeAgents } from '../src/agents/index.js';
import { runRecon } from '../src/modules/recon/fetch.js';

vi.mock('../src/agents/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agents/index.js')>()),
  describeAgents: vi.fn(async () => [
    {
      id: 'builtin',
      name: 'builtin-http',
      available: true,
      multiPhase: true,
      flowCapable: true,
      endpointCapable: true,
      correlationCapable: true,
      description: 'Deterministic preparation fixture',
    },
  ]),
}));
vi.mock('../src/modules/recon/fetch.js', () => ({
  runRecon: vi.fn(async () => {
    throw new Error('Fixture target unavailable');
  }),
}));

afterEach(() => vi.clearAllMocks());

for (const route of ['instantiate', 'compose'] as const) {
  describe(`${route} preparation`, () => {
    async function request(target: string, probeUrl = target) {
      const { app } = await buildApp({
        store: new MemoryStore(),
        auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
        allowedTargets: ['127.0.0.1'],
        logger: false,
        serveStatic: false,
      });
      try {
        return await app.inject({
          method: 'POST',
          url:
            route === 'instantiate'
              ? `/api/playbooks/${PLAYBOOKS[0].id}/instantiate`
              : '/api/suites/compose',
          payload: { target, probeUrl, playbookIds: [PLAYBOOKS[0].id] },
        });
      } finally {
        await app.close();
      }
    }

    it('discovers engines once and preserves recon fallback without starting a campaign', async () => {
      const response = await request('http://127.0.0.1:9/');
      expect(response.statusCode).toBe(201);
      expect(describeAgents).toHaveBeenCalledTimes(1);
      expect(runRecon).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runRecon).mock.calls[0][3].enginesAvailable).toBe(1);
      expect(response.json().recon).toEqual({
        seeded: false,
        error: 'Fixture target unavailable',
      });
      expect(
        response.json().campaigns.every((c: { status: string }) => c.status === 'PENDING_APPROVAL'),
      ).toBe(true);
    });

    it.each([
      ['https://outside.invalid/', 'http://127.0.0.1/'],
      ['http://127.0.0.1/', 'https://outside.invalid/'],
      ['ftp://127.0.0.1/', 'http://127.0.0.1/'],
      ['http://user:password@127.0.0.1/', 'http://127.0.0.1/'],
    ])('rejects destination %s / %s before tool discovery or recon', async (target, probeUrl) => {
      const response = await request(target, probeUrl);
      expect(response.statusCode).toBe(400);
      expect(describeAgents).not.toHaveBeenCalled();
      expect(runRecon).not.toHaveBeenCalled();
    });
  });
}
