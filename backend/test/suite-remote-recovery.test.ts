import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

it('never starts the next suite step when HTTP 200 recovery lacks resource evidence', async () => {
  const target = createServer((_req, res) => res.end('ok'));
  const probe = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          schema: 'ddostester.probe.response/v2',
          requestId: body.requestId,
          observedAt: new Date().toISOString(),
          ok: true,
          status: 200,
          latencyMs: 1,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('PROBE_AGENT_URL', `http://127.0.0.1:${(probe.address() as AddressInfo).port}/probe`);
  vi.stubEnv('PROBE_AGENT_TOKEN', 'private-fixture-token');
  const store = new MemoryStore();
  const auth = initAuth({
    USER_MODE: 'team',
    AUTH_JWT_SECRET: 'fixture',
    AUTH_USERS: JSON.stringify([
      {
        email: 'engineer@wedos',
        role: 'engineer',
        passwordHash: hashPassword('EngineerFixture!123'),
      },
      { email: 'ciso@wedos', role: 'ciso', passwordHash: hashPassword('CisoFixture!123') },
    ]),
  });
  const { app } = await buildApp({
    store,
    auth,
    allowedTargets: ['127.0.0.1'],
    serveStatic: false,
    logger: false,
    suiteRecovery: { needed: 1, intervalMs: 10, maxWaitMs: 1000, requestTimeoutMs: 500 },
  });
  try {
    const login = async (email: string, password: string) =>
      (
        await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })
      ).json().token as string;
    const engineer = await login('engineer@wedos', 'EngineerFixture!123');
    const ciso = await login('ciso@wedos', 'CisoFixture!123');
    const request = (token: string, url: string, payload?: object) =>
      app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${token}` } });
    const playbook = (
      await request(engineer, '/api/playbooks', {
        name: 'Unverified recovery fixture',
        category: 'Custom',
        summary: 'private two-step fixture',
        when: 'test',
        steps: [1, 2].map((n) => ({
          name: `step-${n}`,
          maxRps: 2,
          concurrency: 1,
          maxDurationSec: 1,
          profile: 'constant',
        })),
      })
    ).json();
    const instantiated = (
      await request(engineer, `/api/playbooks/${playbook.id}/instantiate`, {
        target: `http://127.0.0.1:${(target.address() as AddressInfo).port}/`,
      })
    ).json();
    for (const member of instantiated.campaigns) {
      const campaign = (await store.getCampaign(member.id))!;
      await store.saveCampaign({ ...campaign, probeVantage: 'remote' });
    }
    const suiteId = instantiated.campaigns[0].suiteId;
    expect((await request(ciso, `/api/suites/${suiteId}/approve`)).statusCode).toBe(200);
    expect((await request(engineer, `/api/suites/${suiteId}/run`)).statusCode).toBe(202);
    let skipped = false;
    for (let i = 0; i < 80; i++) {
      skipped = (await store.listAudit()).some(
        (entry) =>
          entry.action === 'suite.skip' &&
          entry.campaignId === instantiated.campaigns[1].id &&
          entry.detail?.includes('unverified'),
      );
      if (skipped) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(skipped).toBe(true);
    expect(await store.listRuns(instantiated.campaigns[1].id)).toHaveLength(0);
    expect((await store.getCampaign(instantiated.campaigns[1].id))?.status).toBe('APPROVED');
    const audit = (await store.listAudit()).find(
      (entry) => entry.action === 'suite.skip' && entry.campaignId === instantiated.campaigns[1].id,
    )!;
    expect(audit.detail).toContain('"available":true');
    expect(audit.detail).toContain('"verified":false');
  } finally {
    await app.close();
    vi.unstubAllEnvs();
    await Promise.all([
      new Promise<void>((resolve) => target.close(() => resolve())),
      new Promise<void>((resolve) => probe.close(() => resolve())),
    ]);
  }
}, 20000);
