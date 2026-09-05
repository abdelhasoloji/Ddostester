import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig, iterationRate } from '../engine/loadTest.js';
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

/** One k6 request statement for a method/url/body. */
function k6Call(method: string, url: string, body: string | undefined): string {
  const u = JSON.stringify(url);
  const b = body != null ? JSON.stringify(body) : 'null';
  return method === 'GET' || method === 'HEAD'
    ? `http.request(${JSON.stringify(method)}, ${u}, null, params)`
    : `http.request(${JSON.stringify(method)}, ${u}, ${b}, params)`;
}

/** Builds the k6 script (bounded HTTP load) from the config. Pure function. */
export function buildK6Script(config: LoadTestConfig): string {
  const method = (config.method ?? 'GET').toUpperCase();
  const headers = JSON.stringify(config.headers ?? {});
  const vus = Math.max(1, config.concurrency);
  const flow = config.flow?.length ? config.flow : null;
  // When a flow runs N requests per iteration, cap the ITERATION rate at
  // maxRps/N so the total request rate stays ≤ maxRps.
  const div = flow ? flow.length : 1;
  const rate = (rps: number): number => (flow ? iterationRate(rps, div) : rps);

  const scenario = config.phases?.length
    ? `{
      executor: 'ramping-arrival-rate',
      startRate: ${rate(config.phases[0].maxRps)},
      timeUnit: '1s',
      preAllocatedVUs: ${vus},
      maxVUs: ${vus},
      stages: [${config.phases.map((p) => `{ target: ${rate(p.maxRps)}, duration: '${p.durationSec}s' }`).join(', ')}],
    }`
    : `{
      executor: 'constant-arrival-rate',
      rate: ${rate(config.maxRps)},
      timeUnit: '1s',
      duration: '${config.durationSec}s',
      preAllocatedVUs: ${vus},
      maxVUs: ${vus},
    }`;

  const needsSleep = flow?.some((s) => s.thinkMs) ?? false;
  const imports = `import http from 'k6/http';${needsSleep ? "\nimport { sleep } from 'k6';" : ''}`;

  let bodyFn: string;
  if (flow) {
    bodyFn = flow
      .map((s) => {
        const call = `  ${k6Call(s.method.toUpperCase(), s.url, s.body)};`;
        return s.thinkMs ? `${call}\n  sleep(${(s.thinkMs / 1000).toFixed(3)});` : call;
      })
      .join('\n');
  } else {
    bodyFn = `  ${k6Call(method, config.url, config.body)};`;
  }

  return `${imports}
export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['min', 'med', 'avg', 'p(95)', 'p(99)', 'max'],
  scenarios: { load: ${scenario} },
};
const params = { headers: ${headers} };
export default function () {
${bodyFn}
}
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
  readonly flowCapable = true;
  readonly description =
    'k6 (external) — arrival-rate load, supports ramping scenarios and multi-step flows.';
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
