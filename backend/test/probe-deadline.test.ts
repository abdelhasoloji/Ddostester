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

describe('Probe deadline bounds a stuck tick', () => {
  let url = '';
  // Accepts the connection but NEVER responds — the probe's fetch hangs until its
  // own timeout, which we set far beyond the run's hard deadline. Only the
  // deadline-bound race in run() can stop it (reproduces the 2026-09-12 incident
  // where a pool-starved probe held a run open past its cap).
  const server = createServer(() => {
    /* never respond */
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.(); // force-close the lingering hung socket
        server.close(() => r());
      }),
  );

  it('returns by the hard deadline even when a tick never returns', async () => {
    const kill = new KillSwitch();
    // timeoutMs 10s ≫ the 600ms deadline: without the deadline-bound race, run()
    // would block on the stuck fetch until the 10s abort.
    const probe = new Probe(url, kill, 100, 10_000);
    const t0 = Date.now();
    await probe.run(Date.now() + 600);
    expect(Date.now() - t0).toBeLessThan(3000); // bounded by the deadline, not the timeout
    expect(kill.killed).toBe(false);
  });
});
