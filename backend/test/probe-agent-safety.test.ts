import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { superviseProcess } from '../src/agents/proc.js';

it('refuses probe configuration outside its bounded envelope before binding', () => {
  for (const limits of [
    { PROBE_AGENT_MAX_TIMEOUT_MS: '60001' },
    { PROBE_AGENT_RATE_PER_SEC: '21' },
    { PROBE_AGENT_MAX_IN_FLIGHT: '5' },
    { PROBE_AGENT_MAX_RESPONSE_BYTES: '1048577' },
  ]) {
    const result = spawnSync(process.execPath, [resolve('../deploy/probe-agent/probe-agent.mjs')], {
      timeout: 2000,
      env: {
        ...process.env,
        PROBE_AGENT_TOKEN: 'fixture-token-not-a-secret',
        PROBE_AGENT_ALLOWLIST: '127.0.0.1',
        ...limits,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('listening');
  }
});

it('standalone probe refuses redirects, forbidden hosts and oversized response bodies (loopback fixtures)', async () => {
  let redirectedHits = 0;
  const target = createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => res.end('ok'), 150);
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, {
        location: `http://localhost:${(target.address() as AddressInfo).port}/sink`,
      });
      res.end();
    } else if (req.url === '/sink') {
      redirectedHits++;
      res.end('sink');
    } else {
      res.end('x'.repeat(64));
    }
  });
  const slot = createServer();
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => slot.listen(0, '127.0.0.1', r));
  const port = (slot.address() as AddressInfo).port;
  await new Promise<void>((r) => slot.close(() => r()));
  const ac = new AbortController();
  const child = spawn(process.execPath, [resolve('../deploy/probe-agent/probe-agent.mjs')], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PROBE_AGENT_TOKEN: 'fixture-token-not-a-secret',
      PROBE_AGENT_ALLOWLIST: '127.0.0.1',
      PROBE_AGENT_PORT: String(port),
      PROBE_AGENT_BIND: '127.0.0.1',
      PROBE_AGENT_MAX_RESPONSE_BYTES: '32',
      PROBE_AGENT_MAX_BODY_SLICE: '16',
    },
  });
  child.stdout.resume();
  child.stderr.resume();
  superviseProcess(child, { killSignal: ac.signal, timeoutMs: 8000 });
  const closed = new Promise<void>((r) => child.on('close', () => r()));
  const origin = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 50; i++) {
      try {
        up = (await fetch(origin + '/health')).ok;
      } catch {
        /* Starting. */
      }
      if (up) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(up).toBe(true);
    const request = (
      url: string,
      envelope: Record<string, string> = {
        schema: 'ddostester.probe.request/v2',
        requestId: 'a'.repeat(32),
      },
    ) =>
      fetch(origin + '/probe', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer fixture-token-not-a-secret',
        },
        body: JSON.stringify({ url, ...envelope }),
      });
    const url = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const redirect = await (await request(url + '/redirect')).json();
    expect(redirect.quality).toMatchObject({
      schema: 'ddostester.probe.quality/v1',
      scope: 'process-during-measurement',
    });
    expect(redirect.quality.cpuUserUsec).toBeGreaterThanOrEqual(0);
    expect(redirect.quality.rssBytes).toBeGreaterThan(0);
    expect(redirect.status).toBe(302);
    expect(redirect.schema).toBe('ddostester.probe.response/v2');
    expect(redirect.requestId).toBe('a'.repeat(32));
    expect(Math.abs(Date.now() - Date.parse(redirect.observedAt))).toBeLessThan(2000);
    expect(
      (
        await request(url + '/sink', {
          schema: 'ddostester.probe.request/v2',
          requestId: 'invalid',
        })
      ).status,
    ).toBe(400);
    expect(redirectedHits).toBe(0);
    const parallel = await Promise.all(Array.from({ length: 4 }, () => request(url + '/slow')));
    expect(parallel.filter((response) => response.status === 429)).toHaveLength(2);
    expect(parallel.filter((response) => response.status === 200)).toHaveLength(2);
    await Promise.all(parallel.map((response) => response.arrayBuffer()));
    const oversized = await (await request(url + '/large')).json();
    expect(oversized.ok).toBe(false);
    expect((await request(url.replace('127.0.0.1', 'localhost') + '/sink')).status).toBe(403);
    expect(redirectedHits).toBe(0);
  } finally {
    ac.abort();
    await closed;
    await new Promise<void>((r) => target.close(() => r()));
  }
}, 10000);

it('retains between-request stalls in a bounded recent window and expires old windows', () => {
  const module = resolve('../deploy/probe-agent/quality.mjs');
  const script = `
    import assert from 'node:assert/strict';
    import {performance} from 'node:perf_hooks';
    const {createRecentLoopMonitor,beginProbeQuality}=await import(${JSON.stringify(module)});
    let clock=0;
    const histogram={count:0,max:0,enable(){},disable(){},reset(){this.count=0;this.max=0}};
    const fake=createRecentLoopMonitor({histogram,now:()=>clock,schedule:false});
    assert.equal(fake.snapshot(),null);
    histogram.count=10; histogram.max=250e6; clock=1000; fake.rotate(); clock=1001;
    assert.equal(fake.snapshot().maxMs,250);
    clock=11001; fake.rotate(); assert.equal(fake.snapshot(),null); fake.close();
    await new Promise(r=>setTimeout(r,60));
    const start=performance.now(); while(performance.now()-start<250){}
    await new Promise(r=>setTimeout(r,60));
    const finish=await beginProbeQuality(); const quality=await finish();
    assert.ok(quality.recentEventLoop.samples>0);
    assert.ok(quality.recentEventLoop.maxMs>=150);
    assert.equal(quality.recentEventLoop.scope,'process-recent-window');
    console.log('recent-window-validated');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('recent-window-validated');
});
