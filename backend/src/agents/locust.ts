import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult, RequestStep } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import { runProcess, binaryAvailable, withTempDir } from './proc.js';
import type { ResultMeta } from './results.js';

/**
 * Adapter to Locust (headless), operated by the team. Bounded HTTP load: the
 * rate is bounded by a shared monotonic request pacer. Multi-phase
 * scenarios are delegated to k6/vegeta (Locust would need a LoadTestShape) —
 * explicitly refused so as not to exceed the intended rate.
 */

/** Builds the locustfile (constant bounded HTTP load). Pure function. */
export function buildLocustfile(config: LoadTestConfig): string {
  const timeout = (config.timeoutMs ?? 10_000) / 1000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60)
    throw new AgentError('Invalid Locust timeout.');
  const steps: RequestStep[] = config.flow?.length
    ? config.flow
    : [
        {
          url: new URL(config.url).pathname + new URL(config.url).search,
          method: config.method ?? 'GET',
          body: config.body,
          thinkMs: 0,
        },
      ];
  const calls = steps.flatMap((step) => {
    const headers = JSON.stringify({ ...config.headers, ...step.headers });
    const body = step.body != null ? `, data=${JSON.stringify(step.body)}` : '';
    const call = `        self.send_one(${JSON.stringify(step.method.toUpperCase())}, ${JSON.stringify(step.url)}, headers=${headers}${body})`;
    return step.thinkMs ? [call, `        time.sleep(${step.thinkMs / 1000})`] : [call];
  });
  return `import json, os, time
from pathlib import Path
from gevent.lock import Semaphore
from locust import HttpUser, task, events, constant
from locust.exception import StopUser
_started = 0
_statuses = {}
_lock = Semaphore()
_interval = ${1 / config.maxRps}
_next = time.monotonic() + _interval
_end = time.monotonic() + ${config.durationSec}

@events.request.add_listener
def observed(response=None, **kwargs):
    if response is not None and 100 <= response.status_code <= 599:
        key = str(response.status_code)
        _statuses[key] = _statuses.get(key, 0) + 1

@events.quitting.add_listener
def final_snapshot(environment, **kwargs):
    environment.runner.stop()
    stats = environment.stats.total
    report = {"schema": "locust.final/v1", "started": _started,
              "finalized": stats.num_requests, "failures": stats.num_failures,
              "latencySampleCount": stats.num_requests - stats.num_none_requests,
              "statusCounts": _statuses,
              "latencyMs": {"min": stats.min_response_time or 0,
                            "max": stats.max_response_time or 0,
                            "mean": stats.avg_response_time or 0,
                            "p50": stats.get_response_time_percentile(0.50) or 0,
                            "p95": stats.get_response_time_percentile(0.95) or 0,
                            "p99": stats.get_response_time_percentile(0.99) or 0}}
    fd = os.open(str(Path(__file__).with_suffix('.final.json')), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(report, output, allow_nan=False)

class ShieldTestUser(HttpUser):
    wait_time = constant(0)
    def on_start(self):
        self.client.trust_env = False
    def send_one(self, method, url, **kwargs):
        global _started, _next
        with _lock:
            now = time.monotonic()
            slot = max(now, _next)
            if slot >= _end:
                raise StopUser()
            time.sleep(max(0, slot - now))
            if time.monotonic() >= _end:
                raise StopUser()
            _next = time.monotonic() + _interval
            _started += 1
        with self.client.request(method, url, timeout=${timeout}, allow_redirects=False, catch_response=True, **kwargs) as response:
            if not 200 <= response.status_code < 300:
                response.failure('Non-success HTTP response' if response.status_code else 'No HTTP response')
    @task
    def send_requests(self):
${calls.join('\n')}
`;
}

/** Parses the Locust CSV (<prefix>_stats.csv), the “Aggregated” row. Pure function. */
export function parseLocustStats(csv: string, meta: ResultMeta): LoadTestResult {
  const lines = csv.trim().split('\n');
  const header = splitCsv(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const row = lines
    .slice(1)
    .map(splitCsv)
    .find((r) => r[idx('Name')] === 'Aggregated');
  const num = (r: string[], name: string) => {
    const i = idx(name);
    const v = i >= 0 ? Number(r[i]) : 0;
    return Number.isFinite(v) ? v : 0;
  };
  if (!row) throw new AgentError('Locust did not produce aggregate statistics.');
  const count = (name: string) => {
    const value = row[idx(name)];
    const number = Number(value);
    if (!value?.trim() || !Number.isSafeInteger(number) || number < 0)
      throw new AgentError('Invalid Locust request counters.');
    return number;
  };
  const total = count('Request Count');
  const failed = count('Failure Count');
  if (failed > total) throw new AgentError('Invalid Locust request counters.');
  return {
    id: meta.id,
    config: meta.config,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    totalRequests: total,
    successful: total - failed,
    failed,
    statusCounts: {},
    latencyMs: {
      min: num(row, 'Min Response Time'),
      max: num(row, 'Max Response Time'),
      mean: Number(num(row, 'Average Response Time').toFixed(2)),
      p50: num(row, '50%'),
      p95: num(row, '95%'),
      p99: num(row, '99%'),
    },
    actualRps: Number(num(row, 'Requests/s').toFixed(2)),
    errors: {},
  };
}

/** Native shutdown statistics; the periodically written CSV can omit completed requests. */
export function parseLocustFinal(
  text: string,
  meta: ResultMeta,
  elapsedMs: number,
): LoadTestResult {
  let report: {
    schema: string;
    started: number;
    finalized: number;
    failures: number;
    statusCounts: Record<string, number>;
    latencySampleCount?: number;
    latencyMs: LoadTestResult['latencyMs'];
  };
  try {
    report = JSON.parse(text);
  } catch {
    throw new AgentError('Locust did not produce final statistics.');
  }
  if (
    report?.schema !== 'locust.final/v1' ||
    ![report.started, report.finalized, report.failures].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    report.finalized > report.started ||
    report.failures > report.finalized ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  )
    throw new AgentError('Invalid Locust final counters.');
  if (
    !report.latencyMs ||
    !['min', 'max', 'mean', 'p50', 'p95', 'p99'].every((key) => {
      const n = report.latencyMs[key as keyof LoadTestResult['latencyMs']];
      return typeof n === 'number' && Number.isFinite(n) && n >= 0;
    }) ||
    report.latencyMs.min > report.latencyMs.max
  )
    throw new AgentError('Invalid Locust latency statistics.');
  if (
    !report.statusCounts ||
    typeof report.statusCounts !== 'object' ||
    Array.isArray(report.statusCounts) ||
    Object.entries(report.statusCounts).some(
      ([code, n]) => !/^[1-5][0-9]{2}$/.test(code) || !Number.isSafeInteger(n) || n < 0,
    ) ||
    Object.values(report.statusCounts).reduce((a, b) => a + b, 0) > report.finalized
  )
    throw new AgentError('Invalid Locust HTTP counters.');
  if (
    report.latencySampleCount !== undefined &&
    (!Number.isSafeInteger(report.latencySampleCount) ||
      report.latencySampleCount < 0 ||
      report.latencySampleCount > report.finalized)
  )
    throw new AgentError('Invalid Locust latency sample count.');
  const successful = report.finalized - report.failures;
  return {
    id: meta.id,
    config: meta.config,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    totalRequests: report.started,
    finalizedRequests: report.finalized,
    unfinalizedRequests: report.started - report.finalized,
    successful,
    failed: report.started - successful,
    statusCounts: report.statusCounts,
    latencyMs: report.latencyMs,
    latencyMethod: 'native-rounded-response-times',
    latencySampleCount: report.latencySampleCount,
    actualRps: report.started / (elapsedMs / 1000),
    errors: {},
  };
}

function splitCsv(line: string): string[] {
  // Simple CSV with fields optionally quoted.
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export class LocustAgent implements AttackAgent {
  readonly name = 'locust';
  readonly multiPhase = false;
  readonly flowCapable = true;
  readonly endpointCapable = false;
  readonly correlationCapable = false;
  readonly description =
    'Locust (external, headless) — shared request pacing, supports multi-step flows; use k6/vegeta for phases.';
  constructor(private readonly bin = process.env.LOCUST_BIN ?? 'locust') {}

  available(): Promise<boolean> {
    return binaryAvailable(this.bin, '--version');
  }

  async run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    _onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    validateConfig(config, allowedHosts);
    if (config.phases?.length) {
      throw new AgentError(
        'Multi-phase scenario not supported by the locust agent — use AGENT=k6 or vegeta.',
      );
    }
    if (!(await this.available())) {
      throw new AgentError(
        `locust agent unavailable (binary "${this.bin}"). Install Locust or choose AGENT=builtin.`,
      );
    }
    const startedAt = new Date().toISOString();
    const began = performance.now();
    return withTempDir('locust', async (dir) => {
      const file = join(dir, 'locustfile.py');
      await writeFile(file, buildLocustfile(config), 'utf8');
      const origin = new URL(config.url).origin;
      const prefix = join(dir, 'out');
      await runProcess(
        this.bin,
        [
          '-f',
          file,
          '--headless',
          '-u',
          String(config.concurrency),
          '-r',
          String(config.concurrency),
          '-t',
          `${config.durationSec}s`,
          '--host',
          origin,
          '--csv',
          prefix,
          '--only-summary',
          '--stop-timeout',
          '0',
        ],
        { killSignal },
      );
      const final = await readFile(join(dir, 'locustfile.final.json'), 'utf8').catch(() => '');
      return parseLocustFinal(
        final,
        {
          id: randomUUID(),
          config,
          startedAt,
          finishedAt: new Date().toISOString(),
        },
        performance.now() - began,
      );
    });
  }
}
