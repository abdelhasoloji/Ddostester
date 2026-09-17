import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Probe, KillSwitch } from '../src/modules/probe/probe.js';

/**
 * A controllable target: each request's status and delay are decided by a
 * per-test function of the request index, so we can reproduce a flapping target,
 * a slow-but-up target, a mid-run status-class change, etc. deterministically.
 */
type Behavior = (i: number) => { status: number; delayMs?: number };
let server: Server;
let url = '';
let behavior: Behavior = () => ({ status: 200 });
let count = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    const { status, delayMs } = behavior(count++);
    const send = () => {
      res.statusCode = status;
      res.setHeader('x-probe-test', String(status));
      res.end('x');
    };
    if (delayMs && delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  behavior = () => ({ status: 200 });
  count = 0;
});

describe('Probe — windowed auto-kill (flapping-safe)', () => {
  it('kills a flapping target that never accrues a full run of consecutive failures', async () => {
    // ~33% available (2 down : 1 up): consecutive unavailability never reaches
    // the level-1a threshold, so ONLY the windowed rule can catch this.
    behavior = (i) => ({ status: i % 3 === 2 ? 200 : 503 });
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 300, {
      windowMs: 300,
      windowMinSamples: 4,
      windowKillAvailPct: 50,
      autoKillUnavailableMs: 100_000, // disable the consecutive rule for this test
    });
    await probe.run(Date.now() + 3000);
    expect(kill.killed).toBe(true);
    expect(kill.reason).toBe('KILLED_AUTO');
  });

  it('does NOT kill a merely-degraded target (70% up), and reports health=degraded', async () => {
    behavior = (i) => ({ status: i % 10 < 7 ? 200 : 503 }); // 70% available
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 300, {
      windowMs: 300,
      windowMinSamples: 4,
      windowKillAvailPct: 50,
      degradedAvailPct: 80,
      autoKillUnavailableMs: 100_000,
    });
    await probe.run(Date.now() + 900);
    expect(kill.killed).toBe(false);
    expect(probe.metrics().health).toBe('degraded');
  });
});

describe('Probe — consecutive auto-kill (level 1a, back-compat)', () => {
  it('kills a fully-down target via the consecutive rule', async () => {
    behavior = () => ({ status: 503 });
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 300, {
      autoKillUnavailableMs: 150,
      windowKillAvailPct: 0, // isolate: windowed rule can never fire
    });
    await probe.run(Date.now() + 3000);
    expect(kill.reason).toBe('KILLED_AUTO');
  });

  it('does NOT kill when the generator is provably serving the target (PF1)', async () => {
    // Same "target unavailable to the probe" as above, but the generator is
    // landing successful responses on it — so the probe is contended, not the
    // target down. The kill must be suppressed.
    behavior = () => ({ status: 503 });
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 300, { autoKillUnavailableMs: 150 });
    probe.watchGenerator(() => true); // generator is getting 2xx right now
    await probe.run(Date.now() + 1500);
    expect(kill.reason).toBeNull();
  });

  it('resumes killing once the generator stops succeeding (target really down)', async () => {
    behavior = () => ({ status: 503 });
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 300, {
      autoKillUnavailableMs: 150,
      windowKillAvailPct: 0,
    });
    let genOk = true;
    probe.watchGenerator(() => genOk);
    setTimeout(() => {
      genOk = false;
    }, 300); // generator stalls → real outage → kill allowed
    await probe.run(Date.now() + 3000);
    expect(kill.reason).toBe('KILLED_AUTO');
  });
});

describe('Probe — latency-explosion auto-kill (level 1c, opt-in)', () => {
  it('kills an up-but-slow target when latencyKillMs is set', async () => {
    behavior = () => ({ status: 200, delayMs: 120 });
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 500, {
      windowMs: 300,
      windowMinSamples: 3,
      windowKillAvailPct: 0, // availability is fine; isolate the latency rule
      latencyKillMs: 40,
      autoKillUnavailableMs: 100_000,
    });
    await probe.run(Date.now() + 3000);
    expect(kill.reason).toBe('KILLED_AUTO');
  });

  it('does NOT kill an up-but-slow target by default (latencyKillMs disabled)', async () => {
    behavior = () => ({ status: 200, delayMs: 120 });
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 500); // defaults: latencyKillMs = 0
    await probe.run(Date.now() + 800);
    expect(kill.killed).toBe(false);
  });
});

describe('Probe — health verdict', () => {
  it('reports ok for a healthy target and never auto-kills it', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 300);
    await probe.run(Date.now() + 400);
    expect(kill.killed).toBe(false);
    const m = probe.metrics();
    expect(m.health).toBe('ok');
    // Comfortably healthy (far from any kill threshold). Not an exact 100: under
    // slow CI / coverage instrumentation a single probe sample can land late, so
    // an exact-100 assertion flakes without changing the verdict.
    expect(m.windowAvailPct).toBeGreaterThanOrEqual(90);
  });
});

describe('Probe — header capture on status-class change', () => {
  it('captures headers again when the status class changes mid-run', async () => {
    // Healthy for ~200ms, then flips to 500: a WAF/challenge appearing under
    // load must be captured, not just the first 2xx responses.
    behavior = (i) => ({ status: i < 10 ? 200 : 500 });
    const kill = new KillSwitch();
    const probe = new Probe(url, kill, 20, 300, {
      autoKillUnavailableMs: 100_000,
      windowKillAvailPct: 0,
    });
    await probe.run(Date.now() + 700);
    expect(probe.headerSampleCount()).toBeGreaterThanOrEqual(2);
  });
});
