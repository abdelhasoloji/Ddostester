import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Probe, KillSwitch } from '../src/modules/probe/probe.js';

describe('Probe hard wall-clock deadline', () => {
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

  it('terminates at the hard deadline even when the kill switch never fires', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 100, 500);
    const t0 = Date.now();
    // Deadline ~0.8s out; a healthy target never trips the auto-kill, so without
    // the wall-clock bound this would loop forever.
    await probe.run(Date.now() + 800);
    const elapsed = Date.now() - t0;
    expect(kill.killed).toBe(false); // never auto-killed (target healthy)
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(3000); // stopped promptly, did not hang
  });

  it('still stops when the kill switch fires (deadline unset)', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 100, 500);
    setTimeout(() => kill.trigger('KILLED_MANUAL'), 300);
    const t0 = Date.now();
    await probe.run();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(kill.killed).toBe(true);
  });
});
