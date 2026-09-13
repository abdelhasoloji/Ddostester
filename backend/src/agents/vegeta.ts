import { writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult, ScenarioPhase } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import { runProcess, binaryAvailable, withTempDir } from './proc.js';
import { emptyResult, type ResultMeta } from './results.js';

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
  const n = Math.max(1, Math.min(workers, MAX_VEGETA_PARALLELISM));
  const base = Math.floor(rate / n);
  const rem = rate - base * n;
  return Array.from({ length: n }, (_v, k) => base + (k < rem ? 1 : 0)).filter((r) => r > 0);
}

function cacheBustUrl(url: string, n: number): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_cb=${n.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function buildVegetaTarget(config: LoadTestConfig, bodyFile?: string): string {
  const defaultMethod = (config.method ?? 'GET').toUpperCase();
  const headerLines = Object.entries(config.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
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
  const blocks = targets.map(({ method, url }) => {
    const lines = [`${method} ${url}`, ...headerLines];
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
export function vegetaAttackArgs(
  config: LoadTestConfig,
  phaseRps: number,
  phaseDurationSec: number,
  targetsFile: string,
): string[] {
  const timeoutSec = Math.max(1, Math.ceil((config.timeoutMs ?? 10_000) / 1000));
  // Enough workers to actually reach `phaseRps` (≈ rate × timeout, the worst
  // case where every request runs to the timeout), never below the operator's
  // concurrency, capped so a pathological rate×timeout can't spawn unbounded.
  const workers = Math.min(20_000, Math.max(config.concurrency, Math.ceil(phaseRps * timeoutSec)));
  return [
    'attack',
    '-targets',
    targetsFile,
    '-rate',
    `${phaseRps}/1s`,
    '-duration',
    `${phaseDurationSec}s`,
    '-max-body',
    '0',
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
  const total = parts.reduce((s, p) => s + p.totalRequests, 0);
  const failed = parts.reduce((s, p) => s + p.failed, 0);
  const statusCounts: Record<string, number> = {};
  const errors: Record<string, number> = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.statusCounts))
      statusCounts[k] = (statusCounts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.errors)) errors[k] = (errors[k] ?? 0) + v;
  }
  const wmean = (sel: (r: LoadTestResult) => number) =>
    total
      ? Number((parts.reduce((s, p) => s + sel(p) * p.totalRequests, 0) / total).toFixed(2))
      : 0;
  const elapsed = (Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)) / 1000;
  return {
    ...meta,
    totalRequests: total,
    successful: total - failed,
    failed,
    statusCounts,
    errors,
    latencyMs: {
      min: Math.min(...parts.map((p) => p.latencyMs.min)),
      max: Math.max(...parts.map((p) => p.latencyMs.max)),
      mean: wmean((p) => p.latencyMs.mean),
      p50: wmean((p) => p.latencyMs.p50),
      p95: wmean((p) => p.latencyMs.p95),
      p99: wmean((p) => p.latencyMs.p99),
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
    const attack = spawn(bin, attackArgs);
    const fileWS = createWriteStream(resultsBin);
    attack.stdout.on('error', () => {});
    attack.stdout.pipe(fileWS);

    try {
      const encode = spawn(bin, ['encode', '-to', 'json']);
      encode.on('error', () => {}); // e.g. subcommand unavailable → skip live only
      encode.stdin.on('error', () => {}); // swallow EPIPE if encode exits early
      attack.stdout.pipe(encode.stdin);
      createInterface({ input: encode.stdout }).on('line', (line) => {
        const t = line.trim();
        if (!t) return;
        try {
          const r = JSON.parse(t) as { code?: number; latency?: number; error?: string };
          meter.add({ code: r.code ?? 0, latency: r.latency ?? 0, error: r.error || undefined });
        } catch {
          /* a partial/garbage line — ignore */
        }
      });
    } catch {
      /* live decode unavailable — the file → report path still runs */
    }

    const onAbort = () => attack.kill('SIGTERM');
    killSignal?.addEventListener('abort', onAbort, { once: true });
    const done = () => killSignal?.removeEventListener('abort', onAbort);
    attack.on('error', (e) => {
      done();
      reject(e);
    });
    fileWS.on('error', (e) => {
      done();
      reject(e);
    });
    // The results file being fully flushed is what the final report needs.
    fileWS.on('finish', () => {
      done();
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
        const workers = config.parallelism ?? 1;

        const parts: LoadTestResult[] = [];
        for (let i = 0; i < phases.length; i++) {
          if (killSignal?.aborted) break;
          const ph = phases[i];
          const rates = splitRate(ph.maxRps, workers);
          const finishedAt = () => new Date().toISOString();
          const phaseParts = await Promise.all(
            rates.map(async (rate, k) => {
              const resultsBin = join(dir, `r${i}_${k}.bin`);
              await streamVegetaPhase(
                this.bin,
                vegetaAttackArgs(config, rate, ph.durationSec, targetsFile),
                resultsBin,
                killSignal,
                meter,
              );
              const rep = await runProcess(this.bin, ['report', '-type', 'json', resultsBin], {
                killSignal,
              });
              return parseVegetaReport(JSON.parse(rep.stdout || '{}'), {
                id: `p${i}_${k}`,
                config,
                startedAt,
                finishedAt: finishedAt(),
              });
            }),
          );
          parts.push(...phaseParts);
        }
        const meta: ResultMeta = {
          id: randomUUID(),
          config,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        return mergeResults(parts.length ? parts : [emptyResult(meta)], meta);
      });
    } finally {
      if (ticker) clearInterval(ticker);
    }
  }
}
