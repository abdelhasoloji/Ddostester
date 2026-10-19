#!/usr/bin/env node
/**
 * Measure the built-in engine's delivery instead of trusting it.
 *
 *   node scripts/operations/validate-pacing.mjs --rate 150 --seconds 10
 *   node scripts/operations/validate-pacing.mjs --rate 50 --seconds 10 --concurrency 20
 *   node scripts/operations/validate-pacing.mjs --url http://127.0.0.1:8080/ --rate 150
 *
 * It starts a loopback target, runs the REAL engine against it, and reports:
 *   - delivery: achieved vs configured rate;
 *   - burstiness: the fullest 100 ms window versus the expected share;
 *   - event-loop lag: p50/p95/max during the run (the run-start guard is 250 ms);
 *   - result coherence: latency percentiles, hard-stop flag.
 *
 * The built-in engine saturates near 150 rps. Above that the platform routes to
 * vegeta/k6, so a high rate measured HERE reports under-delivery of the built-in
 * engine, not the pacer. That is why the pacer proof lives at <= 150 rps.
 *
 * Requires `npm run build -w backend` (it imports the compiled engine).
 */
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const enginePath = join(here, '../../backend/dist/engine/loadTest.js');
const { runLoadTest } = await import(pathToFileURL(enginePath).href);

const CEILING = 150;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index >= 0 ? args[index + 1] : fallback;
};

const rate = Number(option('rate', 150));
const seconds = Number(option('seconds', 10));
const concurrency = Number(option('concurrency', 20));
const givenUrl = option('url', '');

if (!Number.isFinite(rate) || rate <= 0) {
  console.error('FAIL: --rate must be a positive number');
  process.exit(2);
}
if (!Number.isFinite(seconds) || seconds < 3) {
  console.error('FAIL: --seconds must be at least 3');
  process.exit(2);
}

let server;
let arrivals = [];
let url = givenUrl;
if (!url) {
  server = createServer((_req, res) => {
    arrivals.push(performance.now());
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
}

const host = new URL(url).hostname;
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
const began = performance.now();
const result = await runLoadTest(
  { url, authorized: true, maxRps: rate, concurrency, durationSec: seconds },
  [host],
);
const elapsed = (performance.now() - began) / 1000;
lag.disable();

if (server) await new Promise((resolve) => server.close(resolve));

const ms = (ns) => Number((ns / 1e6).toFixed(2));
const perWindow = 0.1;
let peak = null;
let peakRatio = null;
if (arrivals.length > 1) {
  const sorted = [...arrivals].sort((a, b) => a - b);
  let start = 0;
  let worst = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end] - sorted[start] > perWindow * 1000) start++;
    worst = Math.max(worst, end - start + 1);
  }
  peak = worst;
  peakRatio = Number((worst / (rate * perWindow)).toFixed(2));
}

const delivery = Number((result.actualRps / rate).toFixed(3));
const lagP95 = ms(lag.percentile(95));
const lagMax = ms(lag.max);

const failures = [];
if (delivery < 0.95) failures.push(`delivery ${(delivery * 100).toFixed(1)}% < 95%`);
if (peakRatio != null && peakRatio > 2.5) failures.push(`burst ${peakRatio}x expected`);
if (lagP95 > 50) failures.push(`event-loop p95 ${lagP95} ms > 50`);
if (lagMax > 250) failures.push(`event-loop max ${lagMax} ms > 250 (guard)`);
if (result.hardStopped) failures.push('run was hard-stopped');

console.log(
  JSON.stringify(
    {
      target: url,
      configuredRps: rate,
      seconds,
      concurrency,
      achievedRps: Number(result.actualRps.toFixed(2)),
      elapsedSec: Number(elapsed.toFixed(2)),
      delivery,
      requests: result.totalRequests,
      failed: result.failed,
      latencyMs: result.latencyMs,
      eventLoopLagMs: { p50: ms(lag.percentile(50)), p95: lagP95, max: lagMax },
      burstinessPer100ms: { expected: Number((rate * perWindow).toFixed(1)), peak, ratio: peakRatio },
      note:
        rate > CEILING
          ? `Above ${CEILING} rps the platform routes to vegeta/k6; this measures the built-in engine's ceiling, not the pacer.`
          : undefined,
      verdict: failures.length === 0 ? 'PASS' : 'FAIL',
      failures,
    },
    null,
    1,
  ),
);
process.exit(failures.length === 0 ? 0 : 1);
