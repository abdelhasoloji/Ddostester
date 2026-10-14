import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createAgent } from '../../backend/src/agents/index.js';
import { stopAllProcesses } from '../../backend/src/agents/proc.js';
import type { LoadTestConfig, LoadTestResult } from '../../backend/src/engine/types.js';
import type { PreparedLoadRun } from '../../backend/src/agents/types.js';

// No configurable target: this recipe owns its dedicated loopback listener.
const [engine, output, mode] = process.argv.slice(2);
if (!['builtin', 'k6', 'vegeta', 'locust', 'jmeter', 'gatling'].includes(engine) || !output) {
  throw new Error(
    'Usage: tsx scripts/conformance/engines.ts ENGINE NEW_PRIVATE_PROOF.json [extended]',
  );
}
if (mode !== undefined && mode !== 'extended') throw new Error('Unknown recipe mode');
const agent = createAgent(engine)!;
// Reserve the proof before sending any request; never overwrite previous evidence.
const proofFile = await open(output, 'wx', 0o600);
const receipts: { atMs: number; path: string }[] = [];
let active = 0;
let peakActive = 0;
let onFirstReceipt: (() => void) | undefined;
const origin = performance.now();
const server = createServer((req, res) => {
  receipts.push({ atMs: performance.now() - origin, path: req.url ?? '' });
  active++;
  peakActive = Math.max(peakActive, active);
  onFirstReceipt?.();
  let finished = false;
  res.on('close', () => {
    if (!finished) {
      finished = true;
      active--;
    }
  });
  if (receipts.length > 80) {
    res.writeHead(429).end();
    return;
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/redirect-followed' }).end();
    return;
  }
  const responseTimer = setTimeout(
    () => res.writeHead(req.url === '/error' ? 503 : 200).end('dedicated conformance target'),
    req.url === '/distribution'
      ? receipts.length <= 3
        ? 5
        : 500
      : req.url === '/timeout'
        ? 1500
        : 600,
  );
  res.on('close', () => clearTimeout(responseTimer));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
const url = `http://127.0.0.1:${address.port}`;
const scenarios: unknown[] = [];
let failure = false;
try {
  if (!(await agent.available())) {
    scenarios.push({ status: 'unavailable', operationalConformance: 'not-validated' });
  } else {
    const recipe = [
      'bounded',
      'redirect',
      'error',
      'timeout',
      'stop',
      ...(mode === 'extended' ? ['flow', 'phases', 'fractional', 'distribution'] : []),
    ];
    for (const scenario of recipe) {
      if (
        (scenario === 'flow' && !agent.flowCapable) ||
        (['phases', 'distribution'].includes(scenario) && !agent.multiPhase)
      ) {
        scenarios.push({
          scenario,
          status: 'unsupported',
          operationalConformance: 'not-validated',
        });
        continue;
      }
      receipts.length = 0;
      peakActive = active;
      const controller = new AbortController();
      let start = performance.now() - origin;
      let preparationMs = 0;
      let preparationReceiptCount = 0;
      let prepared: PreparedLoadRun | undefined;
      let stopAtMs: number | null = null;
      let stopHadActiveRequests = false;
      let watchdog = setTimeout(() => controller.abort(), agent.prepare ? 60_000 : 10_000);
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      if (scenario === 'stop') {
        const stop = () => {
          stopAtMs = performance.now() - origin;
          stopHadActiveRequests = active > 0;
          controller.abort();
        };
        // Exercise a real in-flight request, not only cancellation during binary startup.
        // The startup fallback remains inside the unchanged three-second campaign budget.
        stopTimer = setTimeout(stop, agent.prepare ? 60_000 : 2500);
        onFirstReceipt = () => {
          onFirstReceipt = undefined;
          clearTimeout(stopTimer);
          stopTimer = setTimeout(stop, 150);
        };
      }
      let result: LoadTestResult | null = null;
      const durationSec = scenario === 'fractional' ? 5 : scenario === 'distribution' ? 4 : 3;
      let error: string | null = null;
      try {
        const config: LoadTestConfig = {
          url: `${url}/${['redirect', 'error', 'timeout', 'distribution'].includes(scenario) ? scenario : 'slow'}`,
          method: 'GET',
          concurrency: 2,
          maxRps: scenario === 'fractional' ? 0.5 : scenario === 'flow' ? 1 : 2,
          durationSec,
          timeoutMs: 1000,
          authorized: true,
          ...(scenario === 'flow'
            ? {
                flow: Array.from({ length: 3 }, (_, index) => ({
                  name: `bounded-step-${index}`,
                  method: 'GET' as const,
                  url: `${url}/slow`,
                  thinkMs: 2000,
                })),
              }
            : {}),
          ...(scenario === 'phases'
            ? {
                phases: [
                  { durationSec: 1, maxRps: 1 },
                  { durationSec: 2, maxRps: 2 },
                ],
              }
            : {}),
          ...(scenario === 'distribution'
            ? {
                phases: [
                  { durationSec: 2, maxRps: 2 },
                  { durationSec: 2, maxRps: 2 },
                ],
              }
            : {}),
        };
        if (agent.prepare) {
          prepared = await agent.prepare(config, ['127.0.0.1'], controller.signal);
          preparationMs = performance.now() - origin - start;
          preparationReceiptCount = receipts.length;
          start = performance.now() - origin;
          clearTimeout(watchdog);
          watchdog = setTimeout(() => controller.abort(), 10_000);
          if (scenario === 'stop') {
            clearTimeout(stopTimer);
            stopTimer = setTimeout(() => {
              stopAtMs = performance.now() - origin;
              stopHadActiveRequests = active > 0;
              controller.abort();
            }, 2500);
          }
        }
        result = prepared
          ? await prepared.run()
          : await agent.run(config, ['127.0.0.1'], controller.signal);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        clearTimeout(watchdog);
        clearTimeout(stopTimer);
        onFirstReceipt = undefined;
        await prepared?.dispose();
        await stopAllProcesses();
      }
      const elapsedMs = performance.now() - origin - start;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const checks = {
        preparationNoTraffic: preparationReceiptCount === 0,
        concurrencyBound: peakActive <= 2,
        totalReceiptBound:
          receipts.length <= (scenario === 'fractional' ? 3 : scenario === 'flow' ? 5 : 8),
        fractionalPacing:
          scenario !== 'fractional' ||
          receipts.every((r, i) => i === 0 || r.atMs - receipts[i - 1].atMs >= 1900),
        combinedTail:
          scenario !== 'distribution' ||
          (receipts.length > 3 &&
            result !== null &&
            result.latencyMs.p95 >= 400 &&
            result.latencyMs.p95 < 1000),
        deadlineBound: elapsedMs <= 10_000,
        noRequestsAfterBudget: receipts.every((r) => r.atMs <= start + (durationSec + 1) * 1000),
        noRedirectFollowing: !receipts.some((r) => r.path === '/redirect-followed'),
        stopBound: stopAtMs === null || receipts.every((r) => r.atMs <= stopAtMs! + 1000),
        targetObserved: receipts.length > 0,
        stopExercisedInFlight: scenario !== 'stop' || stopHadActiveRequests,
        completedOrStopped: error === null || scenario === 'stop',
        countersConsistent:
          result === null
            ? scenario === 'stop'
            : result.totalRequests === result.successful + result.failed,
        targetErrorsReported:
          !['redirect', 'error', 'timeout'].includes(scenario) ||
          (result !== null && result.failed > 0 && result.successful === 0),
        targetReceiptsMatch:
          scenario === 'stop' ||
          (result !== null &&
            (result.finalizedRequests === undefined
              ? result.totalRequests === receipts.length
              : result.finalizedRequests <= receipts.length &&
                receipts.length <= result.totalRequests &&
                result.unfinalizedRequests === result.totalRequests - result.finalizedRequests)),
      };
      const passed = Object.values(checks).every(Boolean);
      failure ||= !passed;
      scenarios.push({
        scenario,
        passed,
        checks,
        elapsedMs,
        preparationMs,
        preparationReceiptCount,
        stopAtMs,
        stopHadActiveRequests,
        peakActive,
        receipts: [...receipts],
        result,
        error,
      });
    }
  }
} finally {
  await stopAllProcesses();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
await proofFile.writeFile(
  JSON.stringify(
    {
      schema: 'ddostester.engine.loopback-conformance/v1',
      engine,
      node: process.version,
      createdAt: new Date().toISOString(),
      scope:
        mode === 'extended'
          ? 'bounded GET, redirect, errors, cancellation, long-think flow and two short phases; not full conformance'
          : 'single-phase GET, slow target, redirects, HTTP 503, timeout and cancellation; other capabilities unvalidated',
      config: { concurrency: 2, maxRps: 2, durationSec: 3 },
      scenarios,
    },
    null,
    2,
  ) + '\n',
);
await proofFile.close();
console.log(JSON.stringify({ engine, failure, output }));
if (failure) process.exitCode = 1;
