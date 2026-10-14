import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
it('guards target evidence, persists one audited attachment and rejects concurrent overwrites', async () => {
  const store = new MemoryStore();
  const { app } = await buildApp({
    store,
    serveStatic: false,
    logger: false,
    allowedTargets: ['127.0.0.1'],
    auth: initAuth({
      USER_MODE: 'team',
      AUTH_JWT_SECRET: 'test-secret',
      AUTH_USERS: JSON.stringify([
        { email: 'abdelha@wedos', role: 'admin', passwordHash: hashPassword('test-password-123') },
        { email: 'reader@wedos', role: 'viewer', passwordHash: hashPassword('test-password-123') },
      ]),
    }),
  });
  try {
    await store.saveRun({
      runId: 'run',
      campaignId: 'campaign',
      status: 'COMPLETED',
      generator: {
        config: { url: 'http://127.0.0.1/' },
        startedAt: '2026-10-14T00:00:00Z',
        finishedAt: '2026-10-14T00:00:10Z',
        fleet: {
          measurementComplete: true,
          shards: [
            {
              agentId: 'one',
              state: 'SUCCEEDED',
              attemptId: 'attempt',
              leaseUntil: 0,
              result: { generator: { totalRequests: 1, successful: 1 } },
            },
          ],
        },
      },
    } as unknown as CampaignRun);
    const payload = {
      confirmed: true,
      origin: 'http://127.0.0.1',
      records: [
        {
          trace: 'campaign:run:one:attempt',
          source: '192.0.2.1',
          status: 200,
          epochSec: Date.parse('2026-10-14T00:00:05Z') / 1000,
        },
      ],
    };
    const url = '/api/runs/run/fleet-receipts';
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    const login = async (email: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email, password: 'test-password-123' },
        })
      ).json().token;
    const reader = await login('reader@wedos');
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload,
          headers: { authorization: 'Bearer ' + reader },
        })
      ).statusCode,
    ).toBe(403);
    const owner = await login('abdelha@wedos');
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({ method: 'POST', url, payload, headers: { authorization: 'Bearer ' + owner } }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await store.getRun('run'))?.generator.fleet?.receiverEvidence?.matched).toBe(true);
    expect(
      (await store.listAuditChain()).some((a) => a.detail?.includes('fleet.receiver.import')),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
