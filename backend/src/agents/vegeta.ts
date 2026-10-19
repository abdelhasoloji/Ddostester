import { writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { IO_LIMITS } from '../config/limits.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult, ScenarioPhase } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import {
  runProcess,
  binaryAvailable,
  withTempDir,
  superviseProcess,
  signalProcess,
} from './proc.js';
import { emptyResult, type ResultMeta } from './results.js';
import { mergeHistograms, percentileUpperBound } from '../modules/fleet/aggregate.js';

/**
 * Adapter to Vegeta (fixed-rate HTTP load generator, operated by the team).
 * Rate capped via `-rate`; bounded HTTP load only.
 */

/** Builds the Vegeta targets file. Pure function. With an endpoint set (e.g. a
 *  recon-seeded suite) it emits one target block per endpoint — Vegeta rotates
 *  through them — so the flood hits the real surface, not just the root. Each
 *  block carries the endpoint's method (defaulting to the campaign method). */
/** How many distinct cache-busted URLs to pre-generate per base target. Vegeta
 *  cannot template a URL per request (unlike the built-in engine), so we emit a
 *  pool of unique `?_cb=…` variants that it rotates through — enough that a
 *  cache keyed on the full URL is defeated for the whole run before any repeat. */
const VEGETA_CACHE_BUST_POOL = 400;

/** Max concurrent vegeta processes for parallel generation (P4). Bounded so a
 *  campaign can't fork an unreasonable number of load processes on the host. */
export const MAX_VEGETA_PARALLELISM = 8;

/**
 * Split a phase rate across N workers so the per-worker rates sum EXACTLY to the
 * phase rate (the remainder is spread one-per-worker), and zero-rate workers are
 * dropped. Pure. Used for parallel generation. E.g. splitRate(800, 3) → [267,
 * 267, 266].
 */
export function splitRate(rate: number, workers: number): number[] {
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(workers))
    throw new AgentError('Vegeta rate and worker count must be finite');
  const n = Math.max(1, Math.floor(Math.min(workers, MAX_VEGETA_PARALLELISM)));
  const base = Math.floor(rate / n);
  const rem = rate - base * n;
  return Array.from({ length: n }, (_v, k) => base + Math.min(1, Math.max(0, rem - k))).filter(
    (r) => r > 0,
  );
}

export function vegetaRateSpec(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0)
    throw new AgentError('Vegeta requires a finite positive rate');
  if (Number.isSafeInteger(rate)) return `${rate}/1s`;
  const intervalNs = Math.ceil(1_000_000_000 / rate);
  if (!Number.isSafeInteger(intervalNs) || intervalNs < 1)
    throw new AgentError('Vegeta rate interval cannot be represented safely');
  return `1/${intervalNs}ns`;
}

function cacheBustUrl(url: string, n: number): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_cb=${n.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function buildVegetaTarget(config: LoadTestConfig, bodyFile?: string): string {
  const defaultMethod = (config.method ?? 'GET').toUpperCase();
  const base = config.endpoints?.length
    ? config.endpoints.map((e) => ({
        method: (e.method ?? defaultMethod).toUpperCase(),
        url: e.url,
      }))
    : [{ method: defaultMethod, url: config.url }];
  // Cache-busting: expand each base target into a pool of unique-URL variants so
  // vegeta's static targets file still defeats an edge/page cache.
  const targets = config.cacheBust
    ? base.flatMap(({ method, url }) =>
        Array.from({ length: VEGETA_CACHE_BUST_POOL }, (_v, i) => ({
          method,
          url: cacheBustUrl(url, i),
        })),
      )
    : base;
  // User-Agent rotation: vegeta cannot template a header per request, but it
  // cycles the targets file sequentially — so spreading the UA set across the
  // target blocks rotates the client fingerprint request-by-request, the same
  // realism the built-in engine gets by picking a random UA per request. Emit at
  // least one block per UA so every fingerprint is exercised, and let the
  // per-block `User-Agent` override any global one (dropped from the base lines).
  const uas = config.userAgents?.length ? config.userAgents : null;
  const headerEntries = Object.entries(config.headers ?? {});
  const headerLines = (
    uas ? headerEntries.filter(([k]) => k.toLowerCase() !== 'user-agent') : headerEntries
  ).map(([k, v]) => `${k}: ${v}`);
  const rotated = uas
    ? Array.from({ length: Math.max(targets.length, uas.length) }, (_v, i) => ({
        ...targets[i % targets.length],
        ua: uas[i % uas.length] as string | undefined,
      }))
    : targets.map((t) => ({ ...t, ua: undefined as string | undefined }));
  const blocks = rotated.map(({ method, url, ua }) => {
    const lines = [`${method} ${url}`, ...headerLines];
    if (ua) lines.push(`User-Agent: ${ua}`);
    if (method === 'POST' && bodyFile) lines.push(`@${bodyFile}`);
    return lines.join('\n');
  });
  // Vegeta separates targets by a blank line.
  return blocks.join('\n\n') + '\n';
}

/**
 * Bounded `vegeta attack` args for one phase. Caps MEMORY so a long, high-rate
 * attack against a slow/tarpitting target can't OOM the host (observed: vegeta
 * grew to 10.7 GB and the kernel OOM-killed the control plane mid-suite):
 *   - `-max-body 0`  — discard response bodies (we only score status/latency);
 *     vegeta's default reads and buffers the FULL body of every response. THIS
 *     is what caused the OOM, and it is the memory control.
 *   - `-timeout` — free a hung request promptly instead of holding it 30 s.
 *   - `-max-workers` — vegeta grows workers LAZILY up to this ceiling to hold
 *     the configured rate. It must be high enough to sustain `phaseRps` against
 *     a slow target: holding R rps when each request takes up to T seconds needs
 *     ≈ R×T concurrent workers. Sizing it to the campaign *concurrency* instead
 *     THROTTLED vegeta to a fraction of the target rate on slow endpoints
 *     (observed live: an 80-concurrency step delivered 10 rps against a 400 rps
 *     target, while an identical step on a fast endpoint hit 390). Workers are
 *     cheap goroutines — over-provisioning is free (lazy allocation) and memory
 *     stays bounded by `-max-body 0`, not the worker count — so size for the
 *     rate and floor at the concurrency the operator asked for.
 * Pure, so it is unit-tested.
 */
export function phaseRemainingSec(startedMs: number, plannedEndSec: number, nowMs: number): number {
  // Round down to milliseconds: avoid scientific-notation duration strings
  // close to a boundary, and never round a window beyond its deadline.
  return (
    Math.floor(Math.max(0, plannedEndSec - Math.max(0, nowMs - startedMs) / 1000) * 1000) / 1000
  );
}

export function vegetaEmissionWindowSec(remainingSec: number, rate: number): number {
  return Math.floor(Math.max(0, remainingSec - 1 / rate) * 1000) / 1000;
}

export function vegetaAttackArgs(
  config: LoadTestConfig,
  phaseRps: number,
  phaseDurationSec: number,
  targetsFile: string,
): string[] {
  if (!Number.isFinite(phaseDurationSec) || phaseDurationSec <= 0)
    throw new AgentError('Vegeta duration must be finite and positive; zero means unlimited');
  const timeoutSec = Math.max(1, Math.ceil((config.timeoutMs ?? 10_000) / 1000));
  // Preserve the concurrency cap even when this means rate under-delivery.
  const workers = config.concurrency;
  return [
    'attack',
    '-targets',
    targetsFile,
    '-rate',
    vegetaRateSpec(phaseRps),
    '-duration',
    `${phaseDurationSec}s`,
    '-redirects',
    '0',
    '-max-body',
    '0',
    '-workers',
    `${workers}`,
    '-max-workers',
    `${workers}`,
    '-timeout',
    `${timeoutSec}s`,
    // Fresh connection per request when keep-alive is disabled (connection-accept
    // pressure). Passed explicitly either way so the intent is unambiguous.
    `-keepalive=${config.noKeepAlive ? 'false' : 'true'}`,
  ];
}

interface VegetaReport {
  latencies?: {
    mean?: number;
    '50th'?: number;
    '95th'?: number;
    '99th'?: number;
    max?: number;
    min?: number;
  };
  requests?: number;
  rate?: number;
  success?: number;
  status_codes?: Record<string, number>;
  errors?: string[] | null;
}

const nsToMs = (n: number | undefined): number => Number(((n ?? 0) / 1e6).toFixed(2));

/** Converts a Vegeta report (report -type=json) into a LoadTestResult. Pure function. */
export function parseVegetaReport(rep: VegetaReport, meta: ResultMeta): LoadTestResult {
  const total = rep.requests ?? 0;
  const success = rep.success ?? 1;
  const failed = Math.round(total * (1 - success));
  const l = rep.latencies ?? {};
  const statusCounts: Record<string, number> = {};
  for (const [code, n] of Object.entries(rep.status_codes ?? {})) {
    const bucket = `${code[0]}xx`;
    statusCounts[bucket] = (statusCounts[bucket] ?? 0) + n;
  }
  const errors: Record<string, number> = {};
  for (const e of rep.errors ?? []) errors[e] = (errors[e] ?? 0) + 1;
  return {
    id: meta.id,
    config: meta.config,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    totalRequests: total,
    successful: total - failed,
    failed,
    statusCounts,
    latencyMs: {
      min: nsToMs(l.min),
      max: nsToMs(l.max),
      mean: nsToMs(l.mean),
      p50: nsToMs(l['50th']),
      p95: nsToMs(l['95th']),
      p99: nsToMs(l['99th']),
    },
    actualRps: Number((rep.rate ?? 0).toFixed(2)),
    errors,
  };
}

/** Sums several reports (sequential phases). Pure function. */
export function mergeResults(parts: LoadTestResult[], meta: ResultMeta): LoadTestResult {
  if (parts.length === 1) return { ...parts[0], ...meta };
  if (
    !parts.length ||
    parts.some(
      (part) => !part.latencyHistogram || part.latencyHistogram.count !== part.totalRequests,
    )
  )
    throw new AgentError(
      'Combining phase percentiles requires complete common histograms or raw observations',
    );
  const histogram = mergeHistograms(parts.map((part) => part.latencyHistogram!));
  const quantile = (percent: number) => {
    const value = percentileUpperBound(histogram, percent);
    if (value === null)
      throw new AgentError('Combined percentile is absent or outside histogram bounds');
    return value;
  };
  const total = parts.reduce((s, p) => s + p.totalRequests, 0);
  const failed = parts.reduce((s, p) => s + p.failed, 0);
  const statusCounts: Record<string, number> = {};
  const errors: Record<string, number> = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.statusCounts))
      statusCounts[k] = (statusCounts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.errors)) errors[k] = (errors[k] ?? 0) + v;
  }
  const elapsed = (Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)) / 1000;
  return {
    ...meta,
    totalRequests: total,
    successful: total - failed,
    failed,
    statusCounts,
    errors,
    latencyHistogram: histogram,
    latencyMethod: 'common-histogram-upper-bounds',
    latencyMs: {
      min: Math.min(...parts.map((p) => p.latencyMs.min)),
      max: Math.max(...parts.map((p) => p.latencyMs.max)),
      mean: histogram.sumMs / histogram.count,
      p50: quantile(50),
      p95: quantile(95),
      p99: quantile(99),
    },
    actualRps: Number((total / Math.max(elapsed, 0.001)).toFixed(2)),
  };
}

/** One decoded vegeta result line (`vegeta encode -to json`, one per request). */
export interface VegetaResultLine {
  code: number;
  /** Latency in nanoseconds (vegeta's native unit). */
  latency: number;
  error?: string;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/**
 * Accumulates streamed vegeta results into a live LoadProgress snapshot — the
 * same shape the built-in engine emits, so external-engine runs animate Run
 * Theater (offered/absorbed tiles, timeline) exactly like built-in ones.
 */
export class VegetaLiveMeter {
  private sent = 0;
  private failed = 0;
  private readonly latenciesMs: number[] = [];
  private readonly statusCounts: Record<string, number> = {};

  add(r: VegetaResultLine): void {
    this.sent += 1;
    this.latenciesMs.push(r.latency / 1e6);
    const bucket = r.code >= 100 ? `${String(r.code)[0]}xx` : 'err';
    this.statusCounts[bucket] = (this.statusCounts[bucket] ?? 0) + 1;
    // Successful = a real response in the 2xx/3xx range with no transport error;
    // vegeta reports code 0 for transport failures (tarpit/reset/timeout).
    const ok = !r.error && r.code >= 200 && r.code < 400;
    if (!ok) this.failed += 1;
  }

  snapshot(elapsedSec: number): LoadProgress {
    const snap = [...this.latenciesMs].sort((a, b) => a - b);
    return {
      sent: this.sent,
      successful: this.sent - this.failed,
      failed: this.failed,
      elapsedSec: Number(elapsedSec.toFixed(1)),
      actualRps: Number((this.sent / Math.max(elapsedSec, 0.001)).toFixed(2)),
      latencyMs: {
        p50: Number(pct(snap, 50).toFixed(2)),
        p95: Number(pct(snap, 95).toFixed(2)),
        p99: Number(pct(snap, 99).toFixed(2)),
      },
      statusCounts: { ...this.statusCounts },
    };
  }
}

/**
 * Runs one `vegeta attack` phase, writing its binary results to `resultsBin`
 * (for the unchanged final `vegeta report`) AND, best-effort, decoding a live
 * per-request stream through `vegeta encode` to feed `meter`. Live decoding can
 * never fail the run: the file → report path is the source of truth, and any
 * encode/stream error just stops the live animation for that phase.
 */
export function streamVegetaPhase(
  bin: string,
  attackArgs: string[],
  resultsBin: string,
  killSignal: AbortSignal | undefined,
  meter: VegetaLiveMeter,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // No `-output`: attack writes binary results to stdout, which we tee to the
    // results file (byte-identical to `-output`) and to the live decoder.
    if (killSignal?.aborted) {
      reject(new Error('Process cancelled before spawn'));
      return;
    }
    const attack = spawn(bin, attackArgs, { detached: process.platform !== 'win32' });
    const stop = superviseProcess(attack, { killSignal });
    let decoder: import('node:child_process').ChildProcess | undefined;
    const fileWS = createWriteStream(resultsBin);
    attack.stdout.on('error', () => {});
    attack.stdout.pipe(fileWS);
    let resultBytes = 0;
    let stderrBytes = 0;
    attack.stdout.on('data', (chunk: Buffer) => {
      resultBytes += chunk.length;
      if (resultBytes > IO_LIMITS.processStreamBytes) {
        stop();
        fileWS.destroy(new Error('Process result exceeds disk byte budget'));
      }
    });
    attack.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > IO_LIMITS.processOutputBytes) {
        stop();
        fileWS.destroy(new Error('Process stderr exceeds byte budget'));
      }
    });

    try {
      const encode = spawn(bin, ['encode', '-to', 'json'], {
        detached: process.platform !== 'win32',
      });
      decoder = encode;
      superviseProcess(encode, { killSignal });
      encode.on('error', () => {}); // e.g. subcommand unavailable → skip live only
      encode.stdin.on('error', () => {}); // swallow EPIPE if encode exits early
      attack.stdout.pipe(encode.stdin);
      let pending = '';
      encode.stderr.resume();
      encode.stdout.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(pending) + chunk.length > IO_LIMITS.processOutputBytes) {
          attack.stdout.unpipe(encode.stdin);
          signalProcess(encode, 'SIGKILL');
          encode.stdout.destroy();
          pending = '';
          return;
        }
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          try {
            const r = JSON.parse(line) as { code?: number; latency?: number; error?: string };
            meter.add({ code: r.code ?? 0, latency: r.latency ?? 0, error: r.error || undefined });
          } catch {
            /* Live decode is best-effort. */
          }
        }
      });
    } catch {
      /* live decode unavailable — the file → report path still runs */
    }

    const onAbort = () => {
      stop();
      if (decoder) signalProcess(decoder, 'SIGTERM');
    };
    killSignal?.addEventListener('abort', onAbort, { once: true });
    const done = () => killSignal?.removeEventListener('abort', onAbort);
    attack.on('error', (e) => {
      done();
      stop();
      if (decoder) signalProcess(decoder, 'SIGKILL');
      reject(e);
    });
    fileWS.on('error', (e) => {
      done();
      stop();
      if (decoder) signalProcess(decoder, 'SIGKILL');
      reject(e);
    });
    // The results file being fully flushed is what the final report needs.
    fileWS.on('finish', () => {
      done();
      if (decoder) signalProcess(decoder, 'SIGKILL');
      resolve();
    });
  });
}

export class VegetaAgent implements AttackAgent {
  readonly name = 'vegeta';
  readonly multiPhase = true;
  readonly flowCapable = false;
  readonly endpointCapable = true;
  readonly correlationCapable = false;
  readonly description =
    'Vegeta (external) — fixed-rate load, runs phases sequentially (no multi-step flows).';
  constructor(private readonly bin = process.env.VEGETA_BIN ?? 'vegeta') {}

  available(): Promise<boolean> {
    return binaryAvailable(this.bin, '-version');
  }

  async run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    validateConfig(config, allowedHosts);
    if (!(await this.available())) {
      throw new AgentError(
        `vegeta agent unavailable (binary "${this.bin}"). Install Vegeta or choose AGENT=builtin.`,
      );
    }
    const startedMs = Date.now();
    const startedMonotonicMs = performance.now();
    const startedAt = new Date(startedMs).toISOString();
    // Live meter fed by the streamed results; a 1×/s timer emits the cumulative
    // snapshot so Run Theater animates a vegeta run like a built-in one.
    const meter = new VegetaLiveMeter();
    let ticker: ReturnType<typeof setInterval> | undefined;
    if (onProgress) {
      ticker = setInterval(() => onProgress(meter.snapshot((Date.now() - startedMs) / 1000)), 1000);
      ticker.unref?.();
    }
    try {
      return await withTempDir('vegeta', async (dir) => {
        let bodyFile: string | undefined;
        if ((config.method ?? 'GET').toUpperCase() === 'POST' && config.body != null) {
          bodyFile = join(dir, 'body.txt');
          await writeFile(bodyFile, config.body, 'utf8');
        }
        const targetsFile = join(dir, 'targets.txt');
        await writeFile(targetsFile, buildVegetaTarget(config, bodyFile), 'utf8');

        const phases: ScenarioPhase[] = config.phases?.length
          ? config.phases
          : [{ maxRps: config.maxRps, durationSec: config.durationSec }];

        // Parallel generation (P4, mono-box): spread each phase over N concurrent
        // vegeta processes, each at rate/N, all feeding the one live meter, then
        // aggregate. The TOTAL offered rate is unchanged — only split — so it
        // breaks a single process's ceiling without exceeding the caps.
        const workers = Math.min(config.parallelism ?? 1, config.concurrency);

        const resultFiles: string[] = [];
        let plannedEndSec = 0;
        for (let i = 0; i < phases.length; i++) {
          if (killSignal?.aborted) break;
          const ph = phases[i];
          const plannedStartSec = plannedEndSec;
          plannedEndSec += ph.durationSec;
          const waitMs = plannedStartSec * 1000 - (performance.now() - startedMonotonicMs);
          if (waitMs > 0) {
            try {
              await delay(waitMs, undefined, { signal: killSignal });
            } catch (error) {
              if (killSignal?.aborted) break;
              throw error;
            }
          }
          // Response draining and report parsing consume the next phase's
          // original window; they never move the overall emission deadline.
          const remainingSec = phaseRemainingSec(
            startedMonotonicMs,
            plannedEndSec,
            performance.now(),
          );
          if (remainingSec <= 0) continue;
          // Vegeta checks duration before its pacing sleep. Reserve one full
          // interval so that sleep cannot initiate traffic past the window.
          const rates = splitRate(ph.maxRps, workers).filter(
            (rate) => vegetaEmissionWindowSec(remainingSec, rate) > 0,
          );
          const phaseFiles = await Promise.all(
            rates.map(async (rate, k) => {
              const resultsBin = join(dir, `r${i}_${k}.bin`);
              await streamVegetaPhase(
                this.bin,
                vegetaAttackArgs(
                  {
                    ...config,
                    concurrency:
                      Math.floor(config.concurrency / workers) +
                      (k < config.concurrency % workers ? 1 : 0),
                  },
                  rate,
                  vegetaEmissionWindowSec(remainingSec, rate),
                  targetsFile,
                ),
                resultsBin,
                killSignal,
                meter,
              );
              return resultsBin;
            }),
          );
          resultFiles.push(...phaseFiles);
        }
        const meta: ResultMeta = {
          id: randomUUID(),
          config,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        if (!resultFiles.length) return emptyResult(meta);
        // Parse retained observations after emission stops, including on kill.
        // This offline helper has its own deadline: an aborted emission signal
        // must not discard the evidence required for the final report.
        const report = await runProcess(this.bin, ['report', '-type', 'json', ...resultFiles], {
          timeoutMs: IO_LIMITS.processReportMs,
        });
        if (report.code !== 0) throw new AgentError('Vegeta evidence report failed');
        meta.finishedAt = new Date().toISOString();
        const combined = parseVegetaReport(JSON.parse(report.stdout || '{}'), meta);
        combined.actualRps = Number(
          (
            combined.totalRequests /
            Math.max((performance.now() - startedMonotonicMs) / 1000, 0.001)
          ).toFixed(2),
        );
        combined.latencyMethod = 'native-combined-results';
        return combined;
      });
    } finally {
      if (ticker) clearInterval(ticker);
    }
  }
}
