import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from 'undici';
import { Probe, KillSwitch } from '../src/modules/probe/probe.js';
import { runLoadTest } from '../src/engine/loadTest.js';

/**
 * DETERMINISTIC proof that the probe's dedicated connection pool keeps it
 * measuring the TARGET, not the control plane's own pool contention.
 *
 * Reproduction of the live incident (see shieldtest-probe-pool-fidelity):
 *   - a slow origin (fixed per-request delay),
 *   - the GLOBAL undici pool shrunk to ONE connection to stand in for pool
 *     saturation (Node's global `fetch` — which the builtin generator uses —
 *     dispatches through this),
 *   - the in-process generator flooding the origin at high concurrency, so that
 *     single shared connection is permanently busy with a long queue behind it.
 *
 * A probe that shares the global pool (pre-fix / main) queues behind the flood
 * and times out → false "unavailable". A probe with its OWN dispatcher (this
 * fix) keeps its own connections to the origin and stays healthy.
 *
 * This test PASSES on this branch and FAILS on `origin/main` (where the probe
 * uses global `fetch`): there the probe starves and `available/samples` collapses.
 */
describe('probe pool contention — dedicated pool survives a flood', () => {
  let server: Server;
  const sockets = new Set<import('node:net').Socket>();
  let prevDispatcher: ReturnType<typeof getGlobalDispatcher>;

  afterEach(async () => {
    setGlobalDispatcher(prevDispatcher);
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('keeps measuring the target while the generator saturates the shared pool', async () => {
    // Origin: answers 200 after a fixed delay. Slow enough that a few queued
    // requests on one shared connection blow past the probe's timeout.
    const DELAY_MS = 250;
    server = createServer((_req, res) => {
      setTimeout(() => {
        res.statusCode = 200;
        res.end('ok');
      }, DELAY_MS).unref();
    });
    server.on('connection', (s) => sockets.add(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/`;

    // Stand in for a saturated global pool: ONE connection for all global-fetch
    // traffic. The generator (global fetch) will keep it permanently busy.
    prevDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ connections: 1 }));

    const RUN_MS = 1200;
    const kill = new KillSwitch();
    // Probe: 600ms timeout, 120ms interval. On its own pool one in-flight
    // request (~250ms) settles comfortably; sharing the starved global pool it
    // would wait behind the flood's queued requests (>700ms) and time out. The
    // ONE shared connection is the bottleneck, so a tiny generator (concurrency
    // 4) saturates it — kept minimal so this test adds negligible load to
    // neighbouring timing-sensitive tests.
    const probe = new Probe(url, kill, 120, 600);

    // Concurrent: builtin generator floods over global fetch; probe measures.
    const flood = runLoadTest(
      { url, concurrency: 4, durationSec: Math.ceil(RUN_MS / 1000), maxRps: 60, authorized: true },
      ['127.0.0.1'],
    );
    const probing = probe.run(Date.now() + RUN_MS);
    await Promise.all([flood, probing]);

    const m = probe.metrics();
    // The probe took real samples and the target read as available despite the
    // flood — because it never queued behind the generator.
    expect(m.samples).toBeGreaterThan(2);
    expect(m.available / m.samples).toBeGreaterThan(0.6);
  }, 15000);
});
