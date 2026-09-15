import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Probe, KillSwitch } from '../src/modules/probe/probe.js';

// The probe captures an edge-served error page (a WEDOS origin buckle) that only
// appears under load, so the report and the replay suggestion can use it.
const WEDOS_502 = `WEDOS.PROTECTION · ORIGIN LAYER · HTTP 502
Error: HTTP 502 — origin server returned invalid response
IP:       88.185.186.206
Node:     ac10-Paris
Server:   BE-ALB-AVC-WP
Req-ID:   583990db-1b33-428e-9568-69985139a1f2
Protocol: HTTPS (H3) (443)
Protected by WEDOS.protection`;

describe('Probe captures an edge-served origin-error page', () => {
  let url = '';
  const server = createServer((_q, r) => {
    r.statusCode = 502;
    r.setHeader('server', 'WEDOS.protection');
    r.end(WEDOS_502);
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('records the origin buckle with its leaked diagnostics', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 100, 500);
    await probe.run(Date.now() + 600); // a few ticks against the 502 page
    const errors = probe.edgeErrors();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const origin = errors.find((e) => e.layer === 'origin');
    expect(origin).toBeTruthy();
    expect(origin!.status).toBe(502);
    expect(origin!.vendor).toBe('WEDOS');
    expect(origin!.originIpLeaked).toBe('88.185.186.206');
    // Deduped: one entry per (status, layer) even across many ticks.
    expect(errors.filter((e) => e.layer === 'origin')).toHaveLength(1);
  });
});

describe('Probe keeps no edge-error for a healthy target', () => {
  let url = '';
  const server = createServer((_q, r) => {
    r.statusCode = 200;
    r.end('ok');
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('captures nothing when every response is a healthy 200', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 100, 500);
    await probe.run(Date.now() + 500);
    expect(probe.edgeErrors()).toHaveLength(0);
  });
});
