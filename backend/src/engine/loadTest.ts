import { randomUUID } from 'node:crypto';
import type { LoadTestConfig, LoadTestResult } from './types.js';
import { HTTP_METHODS, MAX_FLOW_STEPS, MAX_THINK_MS } from './types.js';
import { substitute, extractValue } from './correlation.js';
import { percentile } from './stats.js';

export class TargetNotAllowedError extends Error {}
export class InvalidConfigError extends Error {}

/**
 * Effective arrival rate for engines that count ITERATIONS rather than requests:
 * a flow of N steps run at `iterations/s` produces N·iterations/s requests, so
 * the iteration rate is capped at maxRps/N to keep the total request rate ≤
 * maxRps. Always ≥ 1.
 */
export function iterationRate(maxRps: number, stepCount: number): number {
  return Math.max(1, Math.floor(maxRps / Math.max(1, stepCount)));
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
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new TargetNotAllowedError(
      `Target "${parsed.hostname}" is not in the ALLOWED_TARGETS allowlist. ` +
        `Only add hosts you own or are authorized to test.`,
    );
  }
  if (config.concurrency < 1 || config.concurrency > 1000) {
    throw new InvalidConfigError('concurrency must be between 1 and 1000.');
  }
  if (config.durationSec < 1 || config.durationSec > 3600) {
    throw new InvalidConfigError('durationSec must be between 1 and 3600.');
  }
  if (!(config.maxRps > 0)) {
    throw new InvalidConfigError('maxRps must be > 0 (mandatory safety cap).');
  }
  if (config.phases) {
    if (config.phases.length === 0 || config.phases.length > 12) {
      throw new InvalidConfigError('A scenario must have between 1 and 12 phases.');
    }
    for (const p of config.phases) {
      if (!(p.maxRps > 0)) throw new InvalidConfigError('Each phase must have maxRps > 0.');
      if (p.durationSec < 1) throw new InvalidConfigError('Each phase must last ≥ 1 s.');
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
}

/**
 * Runs a load test: `concurrency` parallel loops send requests for
 * `durationSec`, honouring a global `maxRps` cap (simple sliding-window
 * throttling).
 */
export interface LoadProgress {
  sent: number;
  successful: number;
  failed: number;
  elapsedSec: number;
  actualRps: number;
  /**
   * Live probe snapshot, emitted by the runner for every engine (including
   * external ones that don't report per-request counters), so a running
   * campaign always shows target-health feedback.
   */
  probe?: { samples: number; available: number; errorRate5xx: number };
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
  const timeoutMs = config.timeoutMs ?? 10_000;
  // Phases: by default a single phase (durationSec @ maxRps).
  const phases = config.phases?.length
    ? config.phases
    : [{ maxRps: config.maxRps, durationSec: config.durationSec }];
  const totalMs = phases.reduce((s, p) => s + p.durationSec * 1000, 0);
  const deadline = startedAt.getTime() + totalMs;
  const shouldStop = (): boolean => Date.now() >= deadline || killSignal?.aborted === true;

  /** Rate allowed at the current instant based on the ongoing phase. */
  function currentMaxRps(): number {
    let t = Date.now() - startedAt.getTime();
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

  // Throttle: never exceed maxRps requests per second (global).
  let windowStart = Date.now();
  let windowCount = 0;

  async function reserveSlot(): Promise<boolean> {
    while (!shouldStop()) {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount < currentMaxRps()) {
        windowCount++;
        return true;
      }
      await new Promise((r) => setTimeout(r, Math.max(1, 1000 - (now - windowStart))));
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
    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: headers ?? config.headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal: controller.signal,
      });
      latencies.push(performance.now() - t0);
      sent++;
      const bucket = `${Math.floor(res.status / 100)}xx`;
      statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
      if (res.ok) successful++;
      else failed++;
      if (wantBody) {
        const h: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          h[k.toLowerCase()] = v;
        });
        const bodyText = await res.text().catch(() => '');
        return { bodyText, headers: h };
      }
      // Drain the body to release the connection.
      await res.arrayBuffer().catch(() => undefined);
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
    const deadlineMs = Date.now() + ms;
    while (Date.now() < deadlineMs && !shouldStop()) {
      await new Promise((r) => setTimeout(r, Math.min(200, deadlineMs - Date.now())));
    }
  }

  async function worker(): Promise<void> {
    const flow = config.flow?.length ? config.flow : null;
    while (!shouldStop()) {
      if (flow) {
        // Iterate the flow steps in order; each request is rate-limited, so the
        // global maxRps caps the TOTAL request rate across all steps. Per-worker
        // variables carry correlated values (e.g. a login token) between steps.
        const vars: Record<string, string> = {};
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
      } else {
        const ok = await reserveSlot();
        if (!ok) return;
        await doRequest(config.method ?? 'GET', config.url, config.body, config.headers);
      }
    }
  }

  // Emit progress ~1×/s (real-time, CAM-04).
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (onProgress) {
    progressTimer = setInterval(() => {
      const elapsed = (Date.now() - startedAt.getTime()) / 1000;
      onProgress({
        sent,
        successful,
        failed,
        elapsedSec: Number(elapsed.toFixed(1)),
        actualRps: Number((sent / Math.max(elapsed, 0.001)).toFixed(2)),
      });
    }, 1000);
    progressTimer.unref?.();
  }

  try {
    await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }

  const finishedAt = new Date();
  const sorted = [...latencies].sort((a, b) => a - b);
  const elapsedSec = (finishedAt.getTime() - startedAt.getTime()) / 1000;
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

  return {
    id,
    config,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalRequests: sent,
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
  };
}
