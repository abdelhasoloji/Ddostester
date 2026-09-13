import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig, iterationRate } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import { runProcess, binaryAvailable, withTempDir } from './proc.js';
import type { ResultMeta } from './results.js';

/**
 * Adapter to k6 (external load-testing tool, licensed/operated by the team).
 * Generates ONLY bounded HTTP load (GET/POST): k6 is driven in
 * constant/ramping-arrival-rate at the campaign's capped rate. No attack vector
 * is produced by this code — k6 is a standard application-load generator. The
 * same safeguards apply (validateConfig).
 */

/** One k6 request statement for a method/url/body. When cacheBust is set the URL
 *  expression is wrapped in the in-script `_cb()` helper (defined in the script). */
function k6Call(method: string, url: string, body: string | undefined, cacheBust = false): string {
  const u = cacheBust ? `_cb(${JSON.stringify(url)})` : JSON.stringify(url);
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
  const cacheBust = config.cacheBust === true;
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
        const call = `  ${k6Call(s.method.toUpperCase(), s.url, s.body, cacheBust)};`;
        return s.thinkMs ? `${call}\n  sleep(${(s.thinkMs / 1000).toFixed(3)});` : call;
      })
      .join('\n');
  } else if (config.endpoints?.length) {
    // Recon-seeded endpoint set: pick one at random per iteration so the flood
    // spreads over the real surface (matches the built-in engine's endpoint mix).
    const urls = JSON.stringify(config.endpoints.map((e) => e.url));
    const b =
      config.body != null && method !== 'GET' && method !== 'HEAD'
        ? JSON.stringify(config.body)
        : 'null';
    const pick = '_eps[Math.floor(Math.random() * _eps.length)]';
    bodyFn = `  const _eps = ${urls};\n  http.request(${JSON.stringify(method)}, ${cacheBust ? `_cb(${pick})` : pick}, ${b}, params);`;
  } else {
    bodyFn = `  ${k6Call(method, config.url, config.body, cacheBust)};`;
  }

  // In-script cache-buster: appends a unique query param per request so no cache
  // (edge/CDN/page) can serve a stored response — every request hits the origin.
  const cbHelper = cacheBust
    ? `const _cb = (u) => u + (u.indexOf('?') >= 0 ? '&' : '?') + '_cb=' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);\n`
    : '';

  return `${imports}
${cbHelper}export const options = {
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
export function parseK6Summary(summary: K6Summary, meta: ResultMeta): LoadTestResult {
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
  readonly endpointCapable = true;
  readonly correlationCapable = false;
  readonly description =
    'k6 (external) — arrival-rate load, supports ramping scenarios and multi-step flows.';
  constructor(private readonly bin = process.env.K6_BIN ?? 'k6') {}

  available(): Promise<boolean> {
    return binaryAvailable(this.bin, 'version');
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

    const startedAt = new Date().toISOString();
    return withTempDir('k6', async (dir) => {
      const script = join(dir, 'load.js');
      const summaryPath = join(dir, 'summary.json');
      await writeFile(script, buildK6Script(config), 'utf8');
      // k6 exits non-zero if thresholds fail; we read the summary anyway.
      await runProcess(this.bin, ['run', '--summary-export', summaryPath, script], { killSignal });
      const raw = await readFile(summaryPath, 'utf8').catch(() => '{}');
      const summary = JSON.parse(raw) as K6Summary;
      return parseK6Summary(summary, {
        id: randomUUID(),
        config,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    });
  }
}
