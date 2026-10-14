import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { compileIoTProfile } from '../src/engine/iot-profile.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { runLoadTest } from '../src/engine/loadTest.js';
import type { CampaignInput } from '../src/modules/campaigns/model.js';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';

const profile = { id: 'sensor-heartbeat/v1' as const, seed: 42, deviceIndex: 0 };
const base: CampaignInput = {
  name: 'Synthetic sensor',
  target: 'http://127.0.0.1/telemetry',
  probeUrl: 'http://127.0.0.1/health',
  vector: 'http-post',
  agent: 'builtin',
  maxRps: 2,
  concurrency: 1,
  maxDurationSec: 4,
  authorized: true,
  createdBy: 'operator@example.test',
  iotProfile: profile,
};

describe('synthetic IoT profile', () => {
  it('persists the expanded pending flow through the real create/read routes', async () => {
    const store = new MemoryStore();
    const { app } = await buildApp({
      store,
      auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
      allowedTargets: ['127.0.0.1'],
      logger: false,
      serveStatic: false,
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/campaigns', payload: base });
      expect(response.statusCode).toBe(201);
      const created = response.json();
      const read = await app.inject({ method: 'GET', url: `/api/campaigns/${created.id}` });
      expect(read.statusCode).toBe(200);
      expect(read.json().iotProfile).toEqual(profile);
      expect(read.json().flow).toEqual(compileIoTProfile(profile, base.target, base.probeUrl));
      expect(read.json().status).toBe('PENDING_APPROVAL');
      expect(await store.listRuns()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('reproduces identities, small payloads and bounded pauses, with device separation', () => {
    const flow = compileIoTProfile(profile, base.target, base.probeUrl);
    expect(compileIoTProfile({ ...profile }, base.target, base.probeUrl)).toEqual(flow);
    expect(
      compileIoTProfile({ ...profile, deviceIndex: 1 }, base.target, base.probeUrl)[1].body,
    ).not.toEqual(flow[1].body);
    expect(Buffer.byteLength(flow[1].body!)).toBeLessThan(256);
    expect(flow[0].thinkMs).toBeGreaterThanOrEqual(500);
    expect(flow[0].thinkMs).toBeLessThanOrEqual(1500);
    expect(flow[1].thinkMs).toBeGreaterThanOrEqual(1000);
    expect(flow[1].thinkMs).toBeLessThanOrEqual(2000);
  });

  it('compiles a pending campaign without changing budgets or mutating caller data', () => {
    const before = structuredClone(base);
    const campaign = createCampaign(base, ['127.0.0.1']);
    expect(base).toEqual(before);
    expect(campaign.status).toBe('PENDING_APPROVAL');
    expect(campaign.maxRps).toBe(2);
    expect(campaign.concurrency).toBe(1);
    expect(campaign.maxDurationSec).toBe(4);
    expect(campaign.iotProfile).toEqual(profile);
    expect(campaign.flow).toEqual(compileIoTProfile(profile, base.target, base.probeUrl));
    expect(() => createCampaign(campaign, ['127.0.0.1'])).not.toThrow();
    expect(() =>
      createCampaign({ ...campaign, iotProfile: { ...profile, seed: 43 } }, ['127.0.0.1']),
    ).toThrow('differs from its profile');
  });

  it.each([
    { iotProfile: { ...profile, seed: -1 } },
    { iotProfile: { ...profile, seed: 2 ** 32 } },
    { iotProfile: { ...profile, deviceIndex: 0.5 } },
    { iotProfile: { ...profile, deviceIndex: 1000 } },
    { agent: 'fleet' },
    { agent: undefined },
    { vector: 'http-get' },
    { flow: [{ method: 'GET', url: base.probeUrl }] },
    { probeUrl: 'http://localhost/health' },
    { target: 'http://unapproved.example/telemetry', probeUrl: 'http://unapproved.example/health' },
  ])('rejects invalid or conflicting profile inputs: %j', (overrides) => {
    expect(() =>
      createCampaign({ ...base, ...overrides } as CampaignInput, ['127.0.0.1']),
    ).toThrow();
  });

  it('executes the compiled GET/POST journey with its payload and real think-time', async () => {
    const receipts: { method: string; path: string; body: string; type?: string; at: number }[] =
      [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      receipts.push({
        method: req.method!,
        path: req.url!,
        body: Buffer.concat(chunks).toString(),
        type: req.headers['content-type'],
        at: performance.now(),
      });
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing dedicated listener');
      const origin = `http://127.0.0.1:${address.port}`;
      const campaign = createCampaign(
        { ...base, target: `${origin}/telemetry`, probeUrl: `${origin}/health` },
        ['127.0.0.1'],
      );
      const result = await runLoadTest(
        {
          url: campaign.target,
          flow: campaign.flow,
          maxRps: campaign.maxRps,
          concurrency: campaign.concurrency,
          durationSec: campaign.maxDurationSec,
          authorized: true,
        },
        ['127.0.0.1'],
      );
      expect(receipts[0].method).toBe('GET');
      expect(receipts[0].path).toBe('/health');
      expect(receipts[1].method).toBe('POST');
      expect(receipts[1].body).toBe(campaign.flow![1].body);
      expect(receipts[1].type).toBe('application/json');
      expect(receipts[1].at - receipts[0].at).toBeGreaterThanOrEqual(
        campaign.flow![0].thinkMs! - 30,
      );
      expect(result.totalRequests).toBe(receipts.length);
      expect(result.failed).toBe(0);
      expect(receipts.length).toBeLessThanOrEqual(8);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
