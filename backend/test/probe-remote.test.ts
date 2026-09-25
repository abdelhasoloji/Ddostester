import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Probe, KillSwitch } from '../src/modules/probe/probe.js';

// Remote probe vantage: instead of fetching the target directly, the probe asks a
// read-only agent (here a fake standing in for the VPS2 agent) to GET the target
// and report what it saw. These tests drive the acquireRemote() path.

const WEDOS_502 = `WEDOS.PROTECTION · ORIGIN LAYER · HTTP 502
Error: HTTP 502 — origin server returned invalid response
IP:       88.185.186.206
Protected by WEDOS.protection`;

/** A fake agent that requires the bearer token and returns a canned probe result. */
function fakeAgent(result: {
  ok: boolean;
  status: number;
  latencyMs?: number;
  headers?: Record<string, string>;
  bodySlice?: string;
}): { server: Server; seen: { auth?: string; body?: string } } {
  const seen: { auth?: string; body?: string } = {};
  const server = createServer((req, res) => {
    seen.auth = req.headers['authorization'];
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.body = raw;
      if (seen.auth !== 'Bearer test-token') {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ latencyMs: 12, ...result }));
    });
  });
  return { server, seen };
}

describe('Probe remote vantage — healthy target via the agent', () => {
  const { server, seen } = fakeAgent({
    ok: true,
    status: 200,
    headers: { server: 'nginx' },
  });
  let agentUrl = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('records availability from what the agent reports, and forwards auth + target url', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(
      'https://portal.example.eu/',
      kill,
      100,
      500,
      {},
      {
        agentUrl,
        token: 'test-token',
      },
    );
    await probe.run(Date.now() + 500);
    const m = probe.metrics();
    expect(m.samples).toBeGreaterThan(0);
    expect(m.available).toBe(m.samples); // every agent reply was ok:200
    // The probe sent the bearer token and the TARGET url (not the agent url) to probe.
    expect(seen.auth).toBe('Bearer test-token');
    expect(seen.body).toContain('portal.example.eu');
    expect(probe.edgeErrors()).toHaveLength(0);
  });
});

describe('Probe remote vantage — origin buckle forwarded by the agent', () => {
  const { server } = fakeAgent({
    ok: false,
    status: 502,
    headers: { server: 'WEDOS.protection' },
    bodySlice: WEDOS_502,
  });
  let agentUrl = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('captures the edge-served origin error from the forwarded body slice', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(
      'https://portal.example.eu/',
      kill,
      100,
      500,
      {},
      {
        agentUrl,
        token: 'test-token',
      },
    );
    await probe.run(Date.now() + 600);
    const origin = probe.edgeErrors().find((e) => e.layer === 'origin');
    expect(origin).toBeTruthy();
    expect(origin!.status).toBe(502);
    expect(origin!.vendor).toBe('WEDOS');
    expect(origin!.originIpLeaked).toBe('88.185.186.206');
  });
});

describe('Probe remote vantage — agent error is a failed measurement, not a target outage', () => {
  // Agent rejects (wrong token) → every sample is ok:false with status 0.
  const { server } = fakeAgent({ ok: true, status: 200 });
  let agentUrl = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('treats an agent auth failure as unavailable samples', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(
      'https://portal.example.eu/',
      kill,
      100,
      500,
      {},
      {
        agentUrl,
        token: 'WRONG-token',
      },
    );
    await probe.run(Date.now() + 400);
    const m = probe.metrics();
    expect(m.samples).toBeGreaterThan(0);
    expect(m.available).toBe(0);
  });
});
