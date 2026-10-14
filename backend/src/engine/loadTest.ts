import { latencyHistogram } from './stats.js';
import { LATENCY_BUCKETS_MS } from '../config/limits.js';
import { readBoundedBody } from '../util/http-body.js';
import { IO_LIMITS } from '../config/limits.js';
import { randomUUID } from 'node:crypto';
import { Agent, fetch as pooledFetch } from 'undici';
import type { LoadTestConfig, LoadTestResult, WeightedEndpoint } from './types.js';
import {
  HTTP_METHODS,
  MAX_DATASET_ROWS,
  MAX_ENDPOINTS,
  MAX_FLOW_STEPS,
  MAX_THINK_MS,
  MAX_USER_AGENTS,
} from './types.js';
import { substitute, extractValue } from './correlation.js';
import { percentile } from './stats.js';

export class TargetNotAllowedError extends Error {}
export class InvalidConfigError extends Error {}

/**
 * Grace after a kill fires before the run is force-settled, when workers are
 * stranded in an un-abortable queued fetch (undici pool exhaustion). Abortable
 * in-flight requests unwind well within this; the rest are abandoned. Keeps a
 * manual/suite kill responsive instead of waiting out the run's full duration.
 */
export const KILL_BACKSTOP_GRACE_MS = 15_000;

/**
 * Builds a weighted picker over endpoints. Returns a function that, given a
 * random number in [0,1), yields the chosen endpoint in proportion to weights
 * (default weight 1). Pure and deterministic for a given `rand`, so it is
 * unit-testable.
 */
export function buildEndpointPicker(
  endpoints: WeightedEndpoint[],
): (rand: number) => WeightedEndpoint {
  const weights = endpoints.map((e) => (e.weight == null ? 1 : e.weight));
  const total = weights.reduce((s, w) => s + w, 0);
  const cum: number[] = [];
  let acc = 0;
  for (const w of weights) {
    acc += w;
    cum.push(acc);
  }
  return (rand: number) => {
    const x = rand * total;
    for (let i = 0; i < cum.length; i++) {
      if (x < cum[i]) return endpoints[i];
    }
    return endpoints[endpoints.length - 1];
  };
}

/**
 * Effective arrival rate for engines that count ITERATIONS rather than requests:
 * a flow of N steps run at `iterations/s` produces N·iterations/s requests, so
 * the iteration rate is capped at maxRps/N to keep the total request rate ≤
 * maxRps. May be zero when a one-second window cannot fit a whole flow.
 * Integer-only schedulers must widen their time unit rather than raise the cap.
 */
export function iterationRate(maxRps: number, stepCount: number): number {
  return Math.max(0, Math.floor(maxRps / Math.max(1, stepCount)));
}

/**
 * Validates the config. Rejects any target outside the allowlist and any test
 * not explicitly authorized. This is the anti-abuse barrier: the tool can only
 * aim at hosts the operator has declared as their own.
 */
export function validateConfig(config: LoadTestConfig, allowedHosts: string[]): void {
  if (!config.authorized) {
    throw new InvalidConfigError(
      'The test must be explicitly authorized (authorized=true): confirm the target belongs to you.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new InvalidConfigError(`Invalid URL: ${config.url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new InvalidConfigError('Only http and https are supported.');
  }
  if (parsed.username || parsed.password)
    throw new Error('Embedded destination credentials are forbidden');
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new TargetNotAllowedError(
      `Target "${parsed.hostname}" is not in the ALLOWED_TARGETS allowlist. ` +
        `Only add hosts you own or are authorized to test.`,
    );
  }
  if (
    !Number.isSafeInteger(config.concurrency) ||
    config.concurrency < 1 ||
    config.concurrency > 1000
  ) {
    throw new InvalidConfigError('concurrency must be between 1 and 1000.');
  }
  if (!Number.isFinite(config.durationSec) || config.durationSec < 1 || config.durationSec > 3600) {
    throw new InvalidConfigError('durationSec must be between 1 and 3600.');
  }
  if (!Number.isFinite(config.maxRps) || !(config.maxRps > 0)) {
    throw new InvalidConfigError('maxRps must be > 0 (mandatory safety cap).');
  }
  if (config.phases) {
    if (config.phases.length === 0 || config.phases.length > 12) {
      throw new InvalidConfigError('A scenario must have between 1 and 12 phases.');
    }
    for (const p of config.phases) {
      if (!Number.isFinite(p.maxRps) || !(p.maxRps > 0))
        throw new InvalidConfigError('Each phase must have finite maxRps > 0.');
      if (!Number.isFinite(p.durationSec) || p.durationSec < 1)
        throw new InvalidConfigError('Each phase must last a finite ≥ 1 s.');
    }
  }
  if (config.flow) {
    if (config.flow.length === 0 || config.flow.length > MAX_FLOW_STEPS) {
      throw new InvalidConfigError(`A flow must have between 1 and ${MAX_FLOW_STEPS} steps.`);
    }
    for (const step of config.flow) {
      if (!HTTP_METHODS.includes(step.method)) {
        throw new InvalidConfigError(`Flow step: unsupported method "${step.method}".`);
      }
      let stepUrl: URL;
      try {
        stepUrl = new URL(step.url);
      } catch {
        throw new InvalidConfigError(`Flow step: invalid URL (${step.url}).`);
      }
      if (!['http:', 'https:'].includes(stepUrl.protocol)) {
        throw new InvalidConfigError('Flow step: only http and https are supported.');
      }
      if (stepUrl.username || stepUrl.password)
        throw new Error('Embedded destination credentials are forbidden');
      if (!allowedHosts.includes(stepUrl.hostname)) {
        throw new TargetNotAllowedError(
          `Flow step host "${stepUrl.hostname}" is not in the ALLOWED_TARGETS allowlist.`,
        );
      }
      if (step.thinkMs != null && (step.thinkMs < 0 || step.thinkMs > MAX_THINK_MS)) {
        throw new InvalidConfigError(`Flow step: thinkMs must be within [0, ${MAX_THINK_MS}].`);
      }
    }
  }
  if (config.endpoints) {
    if (config.flow?.length) {
      throw new InvalidConfigError('Use either a request flow or an endpoint mix, not both.');
    }
    if (config.endpoints.length === 0 || config.endpoints.length > MAX_ENDPOINTS) {
      throw new InvalidConfigError(`An endpoint mix must have 1 to ${MAX_ENDPOINTS} entries.`);
    }
    let totalWeight = 0;
    for (const ep of config.endpoints) {
      if (ep.method && !HTTP_METHODS.includes(ep.method)) {
        throw new InvalidConfigError(`Endpoint: unsupported method "${ep.method}".`);
      }
      let u: URL;
      try {
        u = new URL(ep.url);
      } catch {
        throw new InvalidConfigError(`Endpoint: invalid URL (${ep.url}).`);
      }
      if (!['http:', 'https:'].includes(u.protocol)) {
        throw new InvalidConfigError('Endpoint: only http and https are supported.');
      }
      if (u.username || u.password)
        throw new Error('Embedded destination credentials are forbidden');
      if (!allowedHosts.includes(u.hostname)) {
        throw new TargetNotAllowedError(
          `Endpoint host "${u.hostname}" is not in the ALLOWED_TARGETS allowlist.`,
        );
      }
      if (ep.weight != null && ep.weight < 0) {
        throw new InvalidConfigError('Endpoint: weight must be >= 0.');
      }
      totalWeight += ep.weight == null ? 1 : ep.weight;
    }
    if (totalWeight <= 0) {
      throw new InvalidConfigError('Endpoint mix: at least one weight must be > 0.');
    }
  }
  if (config.userAgents) {
    if (config.userAgents.length === 0 || config.userAgents.length > MAX_USER_AGENTS) {
      throw new InvalidConfigError(
        `User-Agent rotation must have 1 to ${MAX_USER_AGENTS} entries.`,
      );
    }
    if (config.userAgents.some((ua) => !ua.trim())) {
      throw new InvalidConfigError('User-Agent rotation: entries must be non-empty.');
    }
  }
  if (config.dataset) {
    if (config.dataset.length === 0 || config.dataset.length > MAX_DATASET_ROWS) {
      throw new InvalidConfigError(`Dataset must have 1 to ${MAX_DATASET_ROWS} rows.`);
    }
    if (config.dataset.some((row) => typeof row !== 'object' || row === null)) {
      throw new InvalidConfigError('Dataset: each row must be an object of string values.');
    }
  }
}

/**
 * Runs a load test: `concurrency` parallel loops send requests for
 * `durationSec`, honouring a global `maxRps` cap (simple sliding-window
 * throttling).
 */
export interface LoadProgress {
  runId?: string;
  sent: number;
  successful: number;
  failed: number;
  elapsedSec: number;
  actualRps: number;
  /**
   * Live latency percentiles (ms) over all requests so far — same p50/p95/p99
   * the final result reports, streamed each tick so the drawer shows latency
   * as the run happens (not only at the end).
   */
  latencyMs?: { p50: number; p95: number; p99: number };
  /** Live HTTP status buckets so far (`2xx`/`3xx`/`4xx`/`5xx`). Snapshot copy. */
  statusCounts?: Record<string, number>;
  /**
   * Rolling per-second series for a live sparkline (attached by the runner, not
   * the engine). Structurally a `RunSample[]` slice; typed inline here to keep
   * the engine free of a back-import from the campaigns module.
   */
  timeline?: Array<{
    t: number;
    rps: number;
    sent: number;
    failed: number;
    probe5xx: number;
    availPct: number;
  }>;
  /**
   * Live probe snapshot, emitted by the runner for every engine (including
   * external ones that don't report per-request counters), so a running
   * campaign always shows target-health feedback.
   */
  probe?: {
    samples: number;
    available: number;
    errorRate5xx: number;
    /** Probe's own live latency percentiles (ms). */
    latencyMs?: { p50: number; p95: number; p99: number };
    /** Graduated target-health verdict ('ok' | 'degraded' | 'critical'). */
    health?: 'ok' | 'degraded' | 'critical';
  };
}

export async function runLoadTest(
  config: LoadTestConfig,
  allowedHosts: string[],
  killSignal?: AbortSignal,
  onProgress?: (p: LoadProgress) => void,
): Promise<LoadTestResult> {
  validateConfig(config, allowedHosts);

  const id = randomUUID();
  const startedAt = new Date();
  const startedMonotonic = performance.now();
  const timeoutMs = config.timeoutMs ?? 10_000;
  // A DEDICATED HTTP connection pool for the generator, isolated from Node's
  // global `fetch` pool. Without it a high-concurrency flood saturates the global
  // undici pool and starves every OTHER global-fetch consumer in the process
  // (recon, external-agent adapters, notifications, other probes) — and the probe
  // already carved out its own pool for exactly this reason. Sized to the run's
  // concurrency so the flood still reaches its configured parallelism. TLS is
  // unchanged: the Agent inherits the process-wide NODE_TLS_REJECT_UNAUTHORIZED
  // (INSECURE_TLS), like global fetch.
  const dispatcher = new Agent({ connections: config.concurrency });
  // Phases: by default a single phase (durationSec @ maxRps).
  const phases = config.phases?.length
    ? config.phases
    : [{ maxRps: config.maxRps, durationSec: config.durationSec }];
  const phasesMs = phases.reduce((s, p) => s + p.durationSec * 1000, 0);
  // Hard rule: a run NEVER lasts longer than the campaign's maxDurationSec
  // (config.durationSec), even if the phases were configured to sum beyond it.
  // The absolute per-run cap always wins — this is what stops a scenario whose
  // phases overshoot from running "in the void" past its stated duration.
  const totalMs = Math.min(phasesMs, config.durationSec * 1000);
  const deadline = startedMonotonic + totalMs;
  const shouldStop = (): boolean => performance.now() >= deadline || killSignal?.aborted === true;

  /** Rate allowed at the current instant based on the ongoing phase. */
  function currentMaxRps(): number {
    let t = performance.now() - startedMonotonic;
    for (const p of phases) {
      if (t < p.durationSec * 1000) return p.maxRps;
      t -= p.durationSec * 1000;
    }
    return phases[phases.length - 1].maxRps;
  }

  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let successful = 0;
  let failed = 0;
  let sent = 0;
  let assertionsChecked = 0;
  let assertionFailures = 0;
  const assertion = config.assertion;
  const userAgents = config.userAgents?.length ? config.userAgents : null;

  // Cache-busting: append a unique query param so an edge/CDN/page cache can't
  // serve a stored response — each request is forced through to the origin.
  const cacheBust = config.cacheBust === true;
  const noKeepAlive = config.noKeepAlive === true;
  const withCacheBust = (u: string): string => {
    if (!cacheBust) return u;
    const sep = u.includes('?') ? '&' : '?';
    // A short random token per request; no allocation of a full URL object.
    return `${u}${sep}_cb=${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  };

  // Throttle: never exceed maxRps requests per second (global).
  let windowStart = performance.now();
  let windowCount = 0;
  let lastPermit: number | undefined;

  async function reserveSlot(): Promise<boolean> {
    while (!shouldStop()) {
      const now = performance.now();
      const rate = currentMaxRps();
      if (!Number.isInteger(rate)) {
        // Integer counters must not round a fractional cap up to the next request.
        const due = (lastPermit ?? startedMonotonic) + 1000 / rate;
        if (now >= due) {
          lastPermit = now;
          return true;
        }
        await new Promise((r) =>
          setTimeout(r, Math.max(1, Math.min(100, due - now, deadline - now))),
        );
        continue;
      }
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount < rate) {
        windowCount++;
        lastPermit = now;
        return true;
      }
      await new Promise((r) =>
        setTimeout(r, Math.max(1, Math.min(1000 - (now - windowStart), deadline - now))),
      );
    }
    return false;
  }

  // A single bounded HTTP request (counts toward the global rate cap). Returns
  // response data when `wantBody` is set (for flow correlation), else null.
  async function doRequest(
    method: string,
    url: string,
    body: string | undefined,
    headers: Record<string, string> | undefined,
    wantBody = false,
  ): Promise<{ bodyText: string; headers: Record<string, string> } | null> {
    if (shouldStop() || config.requestPermit?.() === false) return null;
    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Abort an in-flight request immediately when the kill switch fires (manual
    // stop, suite cancel, or the time-based timeout) — don't wait out its own
    // per-request timeout. Without this a killed run keeps draining requests for
    // up to `timeoutMs` against a tarpitting target.
    const reqSignal = killSignal
      ? AbortSignal.any([controller.signal, killSignal])
      : controller.signal;
    // Rotate the User-Agent per request when a set is configured.
    let sendHeaders = headers ?? config.headers;
    if (userAgents) {
      sendHeaders = {
        ...sendHeaders,
        'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)],
      };
    }
    // Ask the origin to close the connection after each response (no keep-alive),
    // so the next request pays a fresh handshake — connection-accept pressure.
    if (noKeepAlive) {
      sendHeaders = { ...sendHeaders, connection: 'close' };
    }
    try {
      const res = await pooledFetch(withCacheBust(url), {
        method,
        headers: sendHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal: reqSignal,
        // Never auto-follow redirects: a 3xx to an off-allowlist host would
        // otherwise escape the allowlist (SSRF). A redirect is measured as the
        // 3xx it is, against the allowlisted host we were told to hit.
        redirect: 'manual',
        // Dedicated pool (see `dispatcher` above) so the flood can never starve
        // the global fetch pool the rest of the process shares.
        dispatcher,
      });
      const latency = performance.now() - t0;
      // Read the body once when a correlation extract or a body assertion needs it.
      const needText = wantBody || assertion?.bodyContains != null;
      let text = '';
      if (needText)
        text = new TextDecoder().decode(
          await readBoundedBody(
            res.body as unknown as ReadableStream<Uint8Array>,
            IO_LIMITS.responseBytes,
          ),
        );
      else
        await readBoundedBody(
          res.body as unknown as ReadableStream<Uint8Array>,
          IO_LIMITS.responseBytes,
          false,
        ); // drain to free the connection
      latencies.push(latency);
      sent++;
      const bucket = `${Math.floor(res.status / 100)}xx`;
      statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
      if (res.ok) successful++;
      else failed++;
      if (assertion) {
        assertionsChecked++;
        const statusOk = assertion.status == null || res.status === assertion.status;
        const bodyOk = assertion.bodyContains == null || text.includes(assertion.bodyContains);
        if (!statusOk || !bodyOk) assertionFailures++;
      }
      if (wantBody) {
        const h: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          h[k.toLowerCase()] = v;
        });
        return { bodyText: text, headers: h };
      }
      return null;
    } catch (err) {
      sent++;
      failed++;
      const name = err instanceof Error ? err.name : 'UnknownError';
      errors[name] = (errors[name] ?? 0) + 1;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Think-time between steps: bounded, and responsive to the kill switch.
  async function think(ms: number): Promise<void> {
    const deadlineMs = performance.now() + ms;
    while (performance.now() < deadlineMs && !shouldStop()) {
      await new Promise((r) =>
        setTimeout(
          r,
          Math.max(1, Math.min(200, deadlineMs - performance.now(), deadline - performance.now())),
        ),
      );
    }
  }

  const pickEndpoint = config.endpoints?.length ? buildEndpointPicker(config.endpoints) : null;
  const dataset = config.dataset?.length ? config.dataset : null;
  const pickRow = (): Record<string, string> =>
    dataset ? dataset[Math.floor(Math.random() * dataset.length)] : {};

  async function worker(): Promise<void> {
    const flow = config.flow?.length ? config.flow : null;
    while (!shouldStop()) {
      if (flow) {
        // Iterate the flow steps in order; each request is rate-limited, so the
        // global maxRps caps the TOTAL request rate across all steps. Per-worker
        // variables carry correlated values (e.g. a login token) between steps.
        // A feeder row (if any) seeds the variables for this iteration.
        const vars: Record<string, string> = { ...pickRow() };
        for (const step of flow) {
          if (shouldStop()) return;
          const ok = await reserveSlot();
          if (!ok) return;
          const url = substitute(step.url, vars);
          const body = step.body != null ? substitute(step.body, vars) : undefined;
          let headers = config.headers;
          if (step.headers) {
            headers = { ...config.headers };
            for (const [k, v] of Object.entries(step.headers)) headers[k] = substitute(v, vars);
          }
          const res = await doRequest(step.method, url, body, headers, step.extract != null);
          if (step.extract && res) {
            const val = extractValue(step.extract.from, step.extract.expr, {
              body: res.bodyText,
              headers: res.headers,
            });
            if (val != null) vars[step.extract.name] = val;
          }
          if (step.thinkMs) await think(step.thinkMs);
        }
      } else if (pickEndpoint) {
        const ok = await reserveSlot();
        if (!ok) return;
        const ep = pickEndpoint(Math.random());
        const row = pickRow();
        const url = dataset ? substitute(ep.url, row) : ep.url;
        const body = ep.body != null ? (dataset ? substitute(ep.body, row) : ep.body) : undefined;
        await doRequest(ep.method ?? 'GET', url, body, config.headers);
      } else {
        const ok = await reserveSlot();
        if (!ok) return;
        const row = pickRow();
        const url = dataset ? substitute(config.url, row) : config.url;
        const body =
          config.body != null ? (dataset ? substitute(config.body, row) : config.body) : undefined;
        await doRequest(config.method ?? 'GET', url, body, config.headers);
      }
    }
  }

  // Emit progress ~1×/s (real-time, CAM-04).
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (onProgress) {
    progressTimer = setInterval(() => {
      const elapsed = (Date.now() - startedAt.getTime()) / 1000;
      // Percentiles over the samples collected so far. Sorting a copy each tick
      // mirrors the final computation; the cost is bounded by the run's rate cap
      // and the timer is unref'd so it never keeps the process alive.
      const snap = [...latencies].sort((a, b) => a - b);
      onProgress({
        runId: id,
        sent,
        successful,
        failed,
        elapsedSec: Number(elapsed.toFixed(1)),
        actualRps: Number((sent / Math.max(elapsed, 0.001)).toFixed(2)),
        latencyMs: {
          p50: Number(percentile(snap, 50).toFixed(2)),
          p95: Number(percentile(snap, 95).toFixed(2)),
          p99: Number(percentile(snap, 99).toFixed(2)),
        },
        statusCounts: { ...statusCounts },
      });
    }, 1000);
    progressTimer.unref?.();
  }

  let abandoned = false;
  try {
    const workers = Promise.all(Array.from({ length: config.concurrency }, () => worker()));
    // Hard backstop: a run NEVER waits past its deadline + a fixed grace, even if
    // in-flight requests to a tarpitting target ignore their AbortSignal. Node's
    // fetch (undici) can leave a request queued on an exhausted keep-alive pool
    // where neither the per-request timeout nor the kill signal cancels it,
    // stranding the worker in `await fetch()` indefinitely. When that happens we
    // abandon the stuck workers and settle the run with the metrics gathered so
    // far; their sockets are reclaimed as the process continues.
    const graceMs = Math.max(0, deadline - performance.now()) + 15_000;
    const backstop = new Promise<void>((resolve) => {
      const finish = (): void => {
        abandoned = true;
        resolve();
      };
      const t = setTimeout(finish, graceMs);
      t.unref?.();
      // A manual/suite kill must take effect PROMPTLY, not only at the run's
      // natural deadline. When workers are stuck in an un-abortable queued fetch
      // (undici pool exhaustion at high concurrency), aborting the kill signal
      // does not free them — so without this a killed run keeps waiting out its
      // full configured duration + grace (an operator clicks "kill" and nothing
      // stops for minutes). Once the kill fires, collapse the backstop to a
      // short grace: abortable requests unwind within it, truly-stuck sockets are
      // abandoned and reclaimed. Whichever backstop fires first wins.
      if (killSignal) {
        const onKill = (): void => {
          const k = setTimeout(finish, KILL_BACKSTOP_GRACE_MS);
          k.unref?.();
        };
        if (killSignal.aborted) onKill();
        else killSignal.addEventListener('abort', onKill, { once: true });
      }
    });
    await Promise.race([workers, backstop]);
    if (abandoned) {
      console.warn(
        `loadTest ${id}: hard-stopped past deadline+grace — some requests to ${config.url} never returned (target tarpit / undici pool exhaustion).`,
      );
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    // Release the generator pool's sockets. `destroy()` (not `close()`) so any
    // request stranded on a tarpitting target is aborted immediately rather than
    // waited on — the run has already settled its metrics by here.
    await dispatcher.destroy().catch(() => undefined);
  }

  const finishedAt = new Date();
  const sorted = [...latencies].sort((a, b) => a - b);
  const elapsedSec = (performance.now() - startedMonotonic) / 1000;
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

  return {
    id,
    config,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalRequests: sent,
    latencyHistogram: latencyHistogram(latencies, LATENCY_BUCKETS_MS),
    successful,
    failed,
    statusCounts,
    latencyMs: {
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      mean: Number(mean.toFixed(2)),
      p50: Number(percentile(sorted, 50).toFixed(2)),
      p95: Number(percentile(sorted, 95).toFixed(2)),
      p99: Number(percentile(sorted, 99).toFixed(2)),
    },
    actualRps: Number((sent / Math.max(elapsedSec, 0.001)).toFixed(2)),
    errors,
    assertionsChecked,
    assertionFailures,
    hardStopped: abandoned,
  };
}
