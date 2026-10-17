import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig, iterationRate } from '../engine/loadTest.js';
import { flowUsesCorrelation } from '../engine/correlation.js';
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

/**
 * Turns a string that may contain `{{name}}` correlation templates into a k6 JS
 * expression: a plain JSON string when there is no template, else a template
 * literal that reads the captured value from `vars` at runtime. Pure.
 */
function k6Interp(s: string): string {
  if (!/\{\{[^}]+\}\}/.test(s)) return JSON.stringify(s);
  const tpl = s
    .split(/(\{\{[^}]+\}\})/g)
    .map((part) => {
      const m = part.match(/^\{\{([^}]+)\}\}$/);
      if (m) return '${vars[' + JSON.stringify(m[1].trim()) + '] ?? ""}';
      // Escape the literal chunks so they are safe inside a `template literal`.
      return part.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    })
    .join('');
  return '`' + tpl + '`';
}

/** k6 params object for a flow step: base headers merged with the step's own,
 *  both interpolated for `{{vars}}`. Returns a JS object-literal expression. */
function k6StepParams(
  baseHeaders: Record<string, string>,
  stepHeaders: Record<string, string> | undefined,
  timeoutMs: number,
) {
  const entries = { ...baseHeaders, ...(stepHeaders ?? {}) };
  const props = Object.entries(entries)
    .map(([k, v]) => `${JSON.stringify(k)}: ${k6Interp(v)}`)
    .join(', ');
  return `{ headers: { ${props} }, timeout: '${timeoutMs}ms' }`;
}

/** One k6 request statement for a method/url/body. When cacheBust is set the URL
 *  expression is wrapped in the in-script `_cb()` helper (defined in the script). */
function k6Call(
  method: string,
  url: string,
  body: string | undefined,
  cacheBust = false,
  params = 'params',
): string {
  const u = cacheBust ? `_cb(${JSON.stringify(url)})` : JSON.stringify(url);
  const b = body != null ? JSON.stringify(body) : 'null';
  return method === 'GET' || method === 'HEAD'
    ? `_request(${JSON.stringify(method)}, ${u}, null, ${params})`
    : `_request(${JSON.stringify(method)}, ${u}, ${b}, ${params})`;
}

/** Builds the k6 script (bounded HTTP load) from the config. Pure function. */
export function buildK6Script(config: LoadTestConfig): string {
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new AgentError('k6 timeoutMs must be within [1, 60000]');
  const method = (config.method ?? 'GET').toUpperCase();
  const baseHeaders = config.headers ?? {};
  const headers = JSON.stringify(baseHeaders);
  const vus = Math.max(1, config.concurrency);
  const cacheBust = config.cacheBust === true;
  const flow = config.flow?.length ? config.flow : null;
  // Correlation (authenticated journeys at high rate): a flow that extracts a
  // value from one response and injects it into later steps via {{name}}. k6
  // must then KEEP response bodies (to read them) and capture into `vars`.
  const correlated = !!flow && flowUsesCorrelation(flow);
  // When a flow runs N requests per iteration, cap the ITERATION rate at
  // maxRps/N so the total request rate stays ≤ maxRps.
  const div = flow ? flow.length : 1;
  const requestedRates = [config.maxRps, ...(config.phases?.map((p) => p.maxRps) ?? [])];
  if (requestedRates.some((rps) => !Number.isFinite(rps) || rps <= 0))
    throw new AgentError('k6 requires a finite positive rate');
  const minimumRps = Math.min(...requestedRates);
  // k6 requires integer arrivals per timeUnit. Widen the shared unit for low
  // rates rather than scheduling at least one whole journey every second.
  const timeUnitSec = Math.max(1, Math.ceil(div / minimumRps));
  if (!Number.isSafeInteger(timeUnitSec))
    throw new AgentError('k6 rate requires an unsupported scheduling period');
  const rate = (rps: number): number => {
    const iterations = iterationRate(rps * timeUnitSec, div);
    if (!Number.isSafeInteger(iterations) || iterations < 1)
      throw new AgentError('k6 rate requires an unsupported arrival count');
    return iterations;
  };

  const scenario = config.phases?.length
    ? `{
      executor: 'ramping-arrival-rate',
      gracefulStop: '0s',
      startRate: ${rate(config.phases[0].maxRps)},
      timeUnit: '${timeUnitSec}s',
      preAllocatedVUs: ${vus},
      maxVUs: ${vus},
      stages: [${config.phases.map((p) => `{ target: ${rate(p.maxRps)}, duration: '${p.durationSec}s' }`).join(', ')}],
    }`
    : `{
      executor: 'constant-arrival-rate',
      gracefulStop: '0s',
      rate: ${rate(config.maxRps)},
      timeUnit: '${timeUnitSec}s',
      duration: '${config.durationSec}s',
      preAllocatedVUs: ${vus},
      maxVUs: ${vus},
    }`;

  const needsSleep = flow?.some((s) => s.thinkMs) ?? false;
  const imports = `import http from 'k6/http';\nimport { Counter } from 'k6/metrics';${needsSleep ? "\nimport { sleep } from 'k6';" : ''}`;

  let bodyFn: string;
  if (flow && correlated) {
    // Correlated flow: per-iteration `vars`, capture extracts, interpolate
    // {{vars}} into every step's URL / body / headers.
    const lines: string[] = ['  const vars = {};'];
    flow.forEach((s, i) => {
      const m = s.method.toUpperCase();
      const urlExpr = cacheBust ? `_cb(${k6Interp(s.url)})` : k6Interp(s.url);
      const bodyExpr =
        m === 'GET' || m === 'HEAD' ? 'null' : s.body != null ? k6Interp(s.body) : 'null';
      const paramsExpr = k6StepParams(baseHeaders, s.headers, timeoutMs);
      const needsResp = !!s.extract;
      const lhs = needsResp ? `  const _r${i} = ` : '  ';
      lines.push(`${lhs}_request(${JSON.stringify(m)}, ${urlExpr}, ${bodyExpr}, ${paramsExpr});`);
      if (s.extract) {
        lines.push(
          `  vars[${JSON.stringify(s.extract.name)}] = _extract(_r${i}, ${JSON.stringify(s.extract.from)}, ${JSON.stringify(s.extract.expr)});`,
        );
      }
      if (s.thinkMs) lines.push(`  sleep(${(s.thinkMs / 1000).toFixed(3)});`);
    });
    bodyFn = lines.join('\n');
  } else if (flow) {
    bodyFn = flow
      .map((s) => {
        const call = `  ${k6Call(
          s.method.toUpperCase(),
          s.url,
          s.body,
          cacheBust,
          k6StepParams(baseHeaders, s.headers, timeoutMs),
        )};`;
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
    bodyFn = `  const _eps = ${urls};\n  _request(${JSON.stringify(method)}, ${cacheBust ? `_cb(${pick})` : pick}, ${b}, params);`;
  } else {
    bodyFn = `  ${k6Call(method, config.url, config.body, cacheBust)};`;
  }

  // In-script cache-buster: appends a unique query param per request so no cache
  // (edge/CDN/page) can serve a stored response — every request hits the origin.
  const cbHelper = cacheBust
    ? `const _cb = (u) => u + (u.indexOf('?') >= 0 ? '&' : '?') + '_cb=' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);\n`
    : '';
  // Correlation extractor (json path / case-insensitive header / regex), mirroring
  // the built-in engine's semantics. Only injected when a flow actually correlates.
  const extractHelper = correlated
    ? `function _extract(r, from, expr) {
  try {
    if (from === 'header') { const h = r.headers || {}; const k = Object.keys(h).find((x) => x.toLowerCase() === expr.toLowerCase()); return k ? String(h[k]) : ''; }
    if (from === 'json') { const v = r.json(expr); return v == null ? '' : String(v); }
    if (from === 'regex') { const m = String(r.body || '').match(new RegExp(expr)); return m ? String(m[1] != null ? m[1] : m[0]) : ''; }
  } catch (e) {}
  return '';
}
`
    : '';

  return `${imports}
${cbHelper}${extractHelper}export const options = {
  maxRedirects: 0,
  discardResponseBodies: ${correlated ? 'false' : 'true'},${config.noKeepAlive ? '\n  noConnectionReuse: true,' : ''}
  summaryTrendStats: ['min', 'med', 'avg', 'p(95)', 'p(99)', 'max'],
  scenarios: { load: ${scenario} },
};
const params = { headers: ${headers}, timeout: '${timeoutMs}ms' };
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }));
const _attempted = new Counter('ddostester_requests_started');
const _successful = new Counter('ddostester_requests_successful');
function _request(method, url, body, params) {
  _attempted.add(1);
  const response = http.request(method, url, body, params);
  if (response.status >= 200 && response.status <= 299) _successful.add(1);
  return response;
}
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
    ddostester_requests_started?: { count?: number; rate?: number };
    ddostester_requests_successful?: { count?: number };
    http_reqs?: { count?: number; rate?: number };
    http_req_failed?: { value?: number };
    http_req_duration?: K6Trend;
  };
}

/** Converts the k6 summary (--summary-export) into a LoadTestResult. Pure function. */
export function parseK6Summary(summary: K6Summary, meta: ResultMeta): LoadTestResult {
  if (
    !summary ||
    !summary.metrics ||
    (!summary.metrics.http_reqs && !summary.metrics.ddostester_requests_started)
  )
    throw new AgentError('k6 summary is missing request measurements');
  const m = summary.metrics;
  const attempts = m.ddostester_requests_started;
  const counter = attempts ?? m.http_reqs;
  if (
    !Number.isSafeInteger(counter?.count) ||
    counter!.count! < 0 ||
    (counter!.count! > 0 && (!Number.isFinite(counter?.rate) || counter!.rate! < 0)) ||
    (!attempts && counter!.count! > 0 && !Number.isFinite(m.http_req_failed?.value))
  )
    throw new AgentError('k6 summary lacks valid request counts, rates or outcomes');
  const total = Math.round(attempts?.count ?? m.http_reqs?.count ?? 0);
  const failRate = m.http_req_failed?.value ?? 0;
  const successful = attempts
    ? Math.round(m.ddostester_requests_successful?.count ?? 0)
    : total - Math.round(total * failRate);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(successful) ||
    successful < 0 ||
    successful > total
  )
    throw new AgentError('k6 summary counters are invalid');
  const failed = total - successful;
  const finalized = attempts ? Math.round(m.http_reqs?.count ?? 0) : undefined;
  if (
    finalized !== undefined &&
    (!Number.isSafeInteger(finalized) || finalized < successful || finalized > total)
  )
    throw new AgentError('k6 finalized counters are invalid');
  const d = m.http_req_duration ?? {};
  const r2 = (n: number | undefined): number => Number((n ?? 0).toFixed(2));

  return {
    id: meta.id,
    config: meta.config,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    totalRequests: total,
    finalizedRequests: finalized,
    latencySampleCount: finalized,
    unfinalizedRequests: finalized === undefined ? undefined : total - finalized,
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
    actualRps: r2(attempts?.rate ?? m.http_reqs?.rate),
    errors: {},
  };
}

export class K6Agent implements AttackAgent {
  readonly name = 'k6';
  readonly multiPhase = true;
  readonly flowCapable = true;
  readonly endpointCapable = true;
  readonly correlationCapable = true;
  readonly description =
    'k6 (external) — arrival-rate load, ramping scenarios, and multi-step flows with correlation (authenticated journeys at high rate).';
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
      // Metrics are exported separately; suppress per-request logs and progress so
      // failing targets cannot exhaust the bounded process-output budget.
      const process = await runProcess(
        this.bin,
        ['run', '--quiet', '--log-output=none', '--summary-export', summaryPath, script],
        { killSignal },
      );
      if (process.code !== 0 && !killSignal?.aborted)
        throw new AgentError(
          `k6 exited with code ${process.code}; no successful execution recorded`,
        );
      const raw = await readFile(summaryPath, 'utf8');
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
