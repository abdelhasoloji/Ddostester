import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeCampaign } from '../src/modules/campaigns/runner.js';
import { KillSwitch } from '../src/modules/probe/probe.js';
import { createCampaign, CampaignError } from '../src/modules/campaigns/service.js';
import type { Campaign, CampaignInput } from '../src/modules/campaigns/model.js';

/**
 * The independent reference vantage (I2): a second endpoint polled alongside the
 * probe with no kill authority, used to attribute an outage to the target vs a
 * broader/local failure.
 */

// Two servers we can independently flip up/down.
let up: Server;
let flappable: Server;
let upBase = '';
let flapBase = '';
let flapStatus = 200;

beforeAll(async () => {
  up = createServer((_q, r) => {
    r.statusCode = 200;
    r.end('ok');
  });
  flappable = createServer((_q, r) => {
    r.statusCode = flapStatus;
    r.end('x');
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => flappable.listen(0, '127.0.0.1', () => r()));
  upBase = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
  flapBase = `http://127.0.0.1:${(flappable.address() as AddressInfo).port}`;
  // Fast probing so the target's own auto-kill trips within the test budget.
  process.env.PROBE_INTERVAL_MS = '20';
  process.env.PROBE_TIMEOUT_MS = '200';
  process.env.PROBE_AUTOKILL_MS = '150';
  process.env.PROBE_WINDOW_KILL_AVAIL_PCT = '0'; // isolate the consecutive rule
});
afterAll(async () => {
  for (const k of [
    'PROBE_INTERVAL_MS',
    'PROBE_TIMEOUT_MS',
    'PROBE_AUTOKILL_MS',
    'PROBE_WINDOW_KILL_AVAIL_PCT',
  ])
    delete process.env[k];
  await new Promise<void>((r) => up.close(() => r()));
  await new Promise<void>((r) => flappable.close(() => r()));
});
afterEach(() => {
  flapStatus = 200;
});

const campaign = (over: Partial<Campaign>): Campaign =>
  ({
    id: 'ref-test',
    name: 'ref',
    target: `${flapBase}/`,
    probeUrl: `${flapBase}/`,
    vector: 'http-get',
    maxRps: 20,
    concurrency: 2,
    maxDurationSec: 5,
    createdBy: 'e@wedos',
    authorized: true,
    status: 'APPROVED',
    createdAt: new Date().toISOString(),
    ...over,
  }) as Campaign;

describe('executeCampaign — reference vantage attribution', () => {
  it('attributes the outage to the target when the reference stays up', async () => {
    flapStatus = 503; // target is down
    const run = await executeCampaign(
      campaign({ referenceUrl: `${upBase}/` }), // reference is healthy
      ['127.0.0.1'],
      new KillSwitch(),
    );
    expect(run.status).toBe('KILLED_AUTO');
    expect(run.reference).toBeDefined();
    expect(run.reference!.targetAttributed).toBe(true);
    expect(run.reference!.availPct).toBeGreaterThan(50);
    expect(run.statusDetail).toMatch(/corroborating/);
  }, 15000);

  it('flags the run inconclusive when the reference is also down', async () => {
    flapStatus = 503; // both the target AND the reference are the same down server
    const run = await executeCampaign(
      campaign({ referenceUrl: `${flapBase}/` }),
      ['127.0.0.1'],
      new KillSwitch(),
    );
    expect(run.status).toBe('KILLED_AUTO');
    expect(run.reference!.targetAttributed).toBe(false);
    expect(run.statusDetail).toMatch(/inconclusive/);
  }, 15000);

  it('omits the reference block when no referenceUrl is set', async () => {
    const run = await executeCampaign(campaign({}), ['127.0.0.1'], new KillSwitch());
    expect(run.reference).toBeUndefined();
  }, 15000);
});

describe('createCampaign — reference validation', () => {
  const input = (over: Partial<CampaignInput>): CampaignInput => ({
    name: 'c',
    target: 'http://127.0.0.1:8080/',
    probeUrl: 'http://127.0.0.1:8080/health',
    vector: 'http-get',
    maxRps: 20,
    concurrency: 2,
    maxDurationSec: 30,
    createdBy: 'e@wedos',
    authorized: true,
    ...over,
  });

  it('accepts an allowlisted reference URL', () => {
    const c = createCampaign(input({ referenceUrl: 'http://127.0.0.1:9000/health' }), [
      '127.0.0.1',
    ]);
    expect(c.referenceUrl).toBe('http://127.0.0.1:9000/health');
  });

  it('rejects a reference URL whose host is not in the allowlist', () => {
    expect(() =>
      createCampaign(input({ referenceUrl: 'http://evil.example/x' }), ['127.0.0.1']),
    ).toThrow(CampaignError);
  });

  it('rejects a non-http reference URL', () => {
    expect(() =>
      createCampaign(input({ referenceUrl: 'file:///etc/passwd' }), ['127.0.0.1']),
    ).toThrow(CampaignError);
  });
});
