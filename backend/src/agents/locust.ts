import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import { runProcess, binaryAvailable } from './proc.js';

/**
 * Adapter to Locust (headless), operated by the team. Bounded HTTP load: the
 * rate is approximated via `constant_pacing` (users / pacing ≈ RPS). Multi-phase
 * scenarios are delegated to k6/vegeta (Locust would need a LoadTestShape) —
 * explicitly refused so as not to exceed the intended rate.
 */

/** Builds the locustfile (constant bounded HTTP load). Pure function. */
export function buildLocustfile(config: LoadTestConfig): string {
  const u = new URL(config.url);
  const path = JSON.stringify(u.pathname + u.search);
  const method = JSON.stringify((config.method ?? 'GET').toUpperCase());
  const headers = JSON.stringify(config.headers ?? {});
  const users = Math.max(1, config.concurrency);
  const pacing = Math.max(0.001, users / config.maxRps); // users/pacing ≈ maxRps
  const dataArg = config.body != null ? `, data=${JSON.stringify(config.body)}` : '';
  return `from locust import HttpUser, task, constant_pacing
class ShieldTestUser(HttpUser):
    wait_time = constant_pacing(${pacing})
    @task
    def run(self):
        self.client.request(${method}, ${path}, headers=${headers}${dataArg}, name=${path})
`;
}

/** Parses the Locust CSV (<prefix>_stats.csv), the “Aggregated” row. Pure function. */
export function parseLocustStats(
  csv: string,
  meta: { id: string; config: LoadTestConfig; startedAt: string; finishedAt: string },
): LoadTestResult {
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
  if (!row) {
    return {
      id: meta.id,
      config: meta.config,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      totalRequests: 0,
      successful: 0,
      failed: 0,
      statusCounts: {},
      latencyMs: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 },
      actualRps: 0,
      errors: {},
    };
  }
  const total = Math.round(num(row, 'Request Count'));
  const failed = Math.round(num(row, 'Failure Count'));
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
    const dir = await mkdtemp(join(tmpdir(), 'shieldtest-locust-'));
    const startedAt = new Date().toISOString();
    try {
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
        ],
        { killSignal },
      );
      const csv = await readFile(`${prefix}_stats.csv`, 'utf8').catch(() => '');
      return parseLocustStats(csv, {
        id: randomUUID(),
        config,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
