import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Probe, KillSwitch } from '../src/modules/probe/probe.js';
import { MAX_PROBE_URLS } from '../src/config/limits.js';

it('does not hide a failed application route behind a healthy root and stops safely', async () => {
  const server = createServer((req, res) => {
    res.statusCode = req.url === '/' ? 200 : 503;
    res.end('observed');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const kill = new KillSwitch();
  const probe = new Probe(root, kill, 10, 1000, { autoKillUnavailableMs: 100 }, undefined, [
    root,
    root + 'login',
  ]);
  try {
    await probe.run(Date.now() + 4000);
    const m = probe.metrics();
    expect(m.samples).toBeGreaterThan(1);
    expect(m.available).toBe(0);
    expect(m.errorRate5xx).toBe(100);
    expect(m.endpoints).toEqual([
      { url: root, samples: m.samples, available: m.samples },
      { url: root + 'login', samples: m.samples, available: 0 },
    ]);
    expect(kill.reason).toBe('KILLED_AUTO');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('rejects a monitor set above the immutable probe URL ceiling', async () => {
  // Constructor validation occurs before any request; release its unused pool.
  const urls = Array.from({ length: MAX_PROBE_URLS + 1 }, (_, i) => `http://localhost/${i}`);
  expect(() => new Probe(urls[0], new KillSwitch(), 5, 5, {}, undefined, urls)).toThrow(
    'Too many probe URLs',
  );
});
