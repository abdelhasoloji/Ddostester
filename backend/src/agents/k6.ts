import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';

/**
 * Adapter to k6 (external load-testing tool, licensed/operated by the team).
 * Generates ONLY bounded HTTP load (GET/POST): k6 is driven in
 * constant/ramping-arrival-rate at the campaign's capped rate. No attack vector
 * is produced by this code — k6 is a standard application-load generator. The
 * same safeguards apply (validateConfig).
 */

/** Builds the k6 script (bounded HTTP load) from the config. Pure function. */
export function buildK6Script(config: LoadTestConfig): string {
  const method = (config.method ?? 'GET').toUpperCase();
  const url = JSON.stringify(config.url);
  const headers = JSON.stringify(config.headers ?? {});
  const body = config.body != null ? JSON.stringify(config.body) : 'null';
  const vus = Math.max(1, config.concurrency);

  const scenario = config.phases?.length
    ? `{
      executor: 'ramping-arrival-rate',
      startRate: ${config.phases[0].maxRps},
      timeUnit: '1s',
      preAllocatedVUs: ${vus},
      maxVUs: ${vus},
      stages: [${config.phases.map((p) => `{ target: ${p.maxRps}, duration: '${p.durationSec}s' }`).join(', ')}],
    }`
    : `{
      executor: 'constant-arrival-rate',
      rate: ${config.maxRps},
      timeUnit: '1s',
      duration: '${config.durationSec}s',
      preAllocatedVUs: ${vus},
      maxVUs: ${vus},
    }`;

  const call =
    method === 'POST'
      ? `http.post(${url}, ${body}, params)`
      : `http.request(${JSON.stringify(method)}, ${url}, null, params)`;

  return `import http from 'k6/http';
export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['min', 'med', 'avg', 'p(95)', 'p(99)', 'max'],
  scenarios: { load: ${scenario} },
};
const params = { headers: ${headers} };
export default function () { ${call}; }
`;
}

interface K6Trend {
  min?: number;
  med?: number;
  avg?: number;
  max?: number;
  'p(95)'?: number;
  'p(99)'?: number;
}
interface K6Summary {
  metrics?: {
    http_reqs?: { count?: number; rate?: number };
    http_req_failed?: { value?: number };
    http_req_duration?: K6Trend;
  };
}

/** Converts the k6 summary (--summary-export) into a LoadTestResult. Pure function. */
export function parseK6Summary(
  summary: K6Summary,
  meta: { id: string; config: LoadTestConfig; startedAt: string; finishedAt: string },
): LoadTestResult {
  const m = summary.metrics ?? {};
  const total = Math.round(m.http_reqs?.count ?? 0);
  const failRate = m.http_req_failed?.value ?? 0;
  const failed = Math.round(total * failRate);
  const d = m.http_req_duration ?? {};
  const r2 = (n: number | undefined): number => Number((n ?? 0).toFixed(2));

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
      min: r2(d.min),
      max: r2(d.max),
      mean: r2(d.avg),
      p50: r2(d.med),
      p95: r2(d['p(95)']),
      p99: r2(d['p(99)']),
    },
    actualRps: r2(m.http_reqs?.rate),
    errors: {},
  };
}

export class K6Agent implements AttackAgent {
  readonly name = 'k6';
  readonly multiPhase = true;
  readonly description = 'k6 (external) — arrival-rate load, supports ramping scenarios.';
  constructor(private readonly bin = process.env.K6_BIN ?? 'k6') {}

  async available(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, ['version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }

  async run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    _onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    // Same safeguards as the built-in generator (allowlist, caps, protocol).
    validateConfig(config, allowedHosts);
    if (!(await this.available())) {
      throw new AgentError(
        `k6 agent unavailable (binary "${this.bin}" not found). Install k6 ` +
          `on the host or choose AGENT=builtin.`,
      );
    }

    const dir = await mkdtemp(join(tmpdir(), 'shieldtest-k6-'));
    const script = join(dir, 'load.js');
    const summaryPath = join(dir, 'summary.json');
    const startedAt = new Date().toISOString();
    try {
      await writeFile(script, buildK6Script(config), 'utf8');
      await new Promise<void>((resolve, reject) => {
        const p = spawn(this.bin, ['run', '--summary-export', summaryPath, script], {
          stdio: 'ignore',
        });
        const onAbort = () => p.kill('SIGTERM');
        killSignal?.addEventListener('abort', onAbort, { once: true });
        p.on('error', reject);
        p.on('close', () => {
          killSignal?.removeEventListener('abort', onAbort);
          resolve(); // k6 exits non-zero if thresholds fail; we read the summary anyway
        });
      });
      const raw = await readFile(summaryPath, 'utf8').catch(() => '{}');
      const summary = JSON.parse(raw) as K6Summary;
      return parseK6Summary(summary, {
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
