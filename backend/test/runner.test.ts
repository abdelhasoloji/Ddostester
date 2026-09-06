import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeCampaign } from '../src/modules/campaigns/runner.js';
import { KillSwitch } from '../src/modules/probe/probe.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

describe('executeCampaign — run time-series', () => {
  let base: string;
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('captures a per-second timeline persisted with the run', async () => {
    const campaign = {
      id: 'test-run',
      name: 'timeline',
      target: `${base}/`,
      probeUrl: `${base}/`,
      vector: 'http-get',
      maxRps: 20,
      concurrency: 2,
      maxDurationSec: 2,
      createdBy: 'e@wedos',
      authorized: true,
      status: 'APPROVED',
      createdAt: new Date().toISOString(),
    } as Campaign;

    const run = await executeCampaign(campaign, ['127.0.0.1'], new KillSwitch());

    expect(Array.isArray(run.timeline)).toBe(true);
    expect(run.timeline!.length).toBeGreaterThan(0);
    const s = run.timeline![0];
    expect(s.t).toBeGreaterThanOrEqual(0);
    expect(s.availPct).toBeGreaterThanOrEqual(0);
    expect(s.availPct).toBeLessThanOrEqual(100);
    // Samples are ordered by elapsed time.
    const ts = run.timeline!.map((x) => x.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  }, 15000);
});
