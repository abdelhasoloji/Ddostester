import { probeChallenge, validateProbeFreshness, validateRemoteSample } from './remote.js';
import { summarizeProbeQuality, type ProbeQuality } from './quality.js';
/**
 * PROBE — legitimate probe (TSD §5.3). Measures the availability and latency of
 * an endpoint during a campaign, and drives the KILL SWITCH:
 *   1a. auto-kill — consecutive unavailability ≥ `autoKillUnavailableMs`
 *   1b. auto-kill — availability over a full window < `windowKillAvailPct`
 *                   (catches a flapping target that never accrues 1a)
 *   1c. auto-kill — sustained window p95 latency > `latencyKillMs` (opt-in)
 *   2.  manual    — call to KillSwitch.trigger('KILLED_MANUAL')
 *   3.  time      — absolute timeout (set by the caller, ≤ 15 min)
 * Between healthy and killed it also reports a graduated `health` state
 * ('ok' | 'degraded' | 'critical') so an operator sees trouble coming before a
 * hard kill. It emits no attack load: these are legitimate measurement requests.
 */

import { fetch as pooledFetch, Agent } from 'undici';
import { readBoundedBody } from '../../util/http-body.js';
import { analyzePosture } from '../posture/analyze.js';
import type { PostureReport } from '../posture/analyze.js';
import { detectEdgeError } from '../posture/edge-error.js';
import type { EdgeErrorSignal } from '../posture/edge-error.js';
import { percentile } from '../../engine/stats.js';
import { PROBE_LIMITS, IO_LIMITS, MAX_PROBE_URLS } from '../../config/limits.js';
import type { ProbeLimits } from '../../config/limits.js';

export interface ProbeSample {
  quality?: ProbeQuality;
  at: number;
  ok: boolean;
  status: number;
  /** Time to response headers (TTFB) in ms, or time-to-failure on error. */
  latencyMs: number;
}

/** Graduated probe verdict: green / amber / red. */
export type ProbeHealth = 'ok' | 'degraded' | 'critical';

export interface ProbeMetrics {
  quality?: {
    latest?: ProbeQuality;
    measuredSamples: number;
    totalSamples: number;
    peakEventLoopDelayMs: number | null;
    peakRecentEventLoopDelayMs?: number | null;
    eventLoopMeasuredSamples?: number;
    peakThrottledFraction: number | null;
  };
  /** Aggregate samples are cycles: every monitored URL must succeed. */
  endpoints?: { url: string; samples: number; available: number }[];
  samples: number;
  available: number;
  errorRate5xx: number;
  latencyMs: { p50: number; p95: number; p99: number };
  successful: number;
  /** Graduated health verdict at the time metrics were read (optional so older
   *  persisted runs deserialize cleanly). */
  health?: ProbeHealth;
  /** Availability (%) over the most recent sliding window. */
  windowAvailPct?: number;
}

export type KillReason = 'KILLED_AUTO' | 'KILLED_MANUAL' | 'TIMEOUT' | null;

export class KillSwitch {
  reason: KillReason = null;
  private controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get killed(): boolean {
    return this.reason !== null;
  }
  trigger(reason: Exclude<KillReason, null>): void {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
  }
}

const MAX_HEADER_SNAPSHOTS = 8;
// Cap the edge-error pages we keep (one per distinct status/layer is enough
// evidence); decode at most this many bytes of an error body to classify it.
const MAX_EDGE_ERRORS = 6;
const MAX_EDGE_BODY_BYTES = 20000;

/** HTTP status → coarse class, used to capture headers on a class transition. */
function statusClass(status: number): string {
  if (status <= 0) return 'err';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}

export class Probe {
  private samples: ProbeSample[] = [];
  private endpointCounts = new Map<string, { samples: number; available: number }>();
  private readonly urls: string[];
  private readonly qualities: ProbeQuality[] = [];
  private unavailableSince: number | null = null;
  /** A bounded set of response-header snapshots for posture inference. */
  private headerSnapshots: Record<string, string>[] = [];
  private edgeErrorSignals: EdgeErrorSignal[] = [];
  /** Last observed status class, so we snapshot headers on a *transition*. */
  private lastStatusClass: string | null = null;
  private readonly limits: ProbeLimits;
  /**
   * A DEDICATED HTTP connection pool for the probe, isolated from the load
   * generator's. The builtin generator uses Node's global `fetch` (the global
   * undici pool); under a high-concurrency in-process flood that pool saturates
   * and a probe sharing it would time out — recording a false "unavailable" that
   * reflects our own pool contention, not the target. Its own small pool lets
   * the probe keep measuring the *target's* health. TLS behaviour is unchanged
   * (it inherits the process-wide NODE_TLS_REJECT_UNAUTHORIZED, like global
   * fetch), and undici's fetch keeps the same redirect/headers semantics.
   */
  readonly dispatcher = new Agent({ connections: 4 });

  /** Optional diagnostic hook; it NEVER affects safety thresholds. */
  watchGenerator(_fn: () => boolean): void {
    /* Backward-compatible no-op. */
  }

  constructor(
    private readonly url: string,
    private readonly kill: KillSwitch,
    private readonly intervalMs = PROBE_LIMITS.intervalMs,
    private readonly timeoutMs = PROBE_LIMITS.timeoutMs,
    limits: Partial<ProbeLimits> = {},
    /**
     * Optional remote vantage: when set, each sample is taken by a read-only
     * probe agent on another host (e.g. VPS2 over the tailnet) instead of
     * directly from this process. Used when the target rate-limits by source IP,
     * so the probe would otherwise collide with the load generator's IP. The
     * agent reports what IT saw (status/latency/headers), measured from its own
     * source IP. Absent = local vantage (direct fetch).
     */
    private readonly remote?: { agentUrl: string; token: string },
    urls: string[] = [],
  ) {
    // Positional interval/timeout win (back-compat with existing callers/tests);
    // everything else comes from the merged limits.
    this.limits = { ...PROBE_LIMITS, ...limits, intervalMs, timeoutMs };
    this.urls = [...new Set([url, ...urls])];
    if (this.urls.length > MAX_PROBE_URLS) throw new Error('Too many probe URLs');
  }

  /**
   * Polls the target until the kill switch fires OR an absolute wall-clock
   * deadline is reached. The deadline is a hard safety bound: it guarantees the
   * probe (and thus the run's `Promise.all`) always terminates near the campaign
   * cap, even if the kill switch is never triggered — so a run can never hang
   * open indefinitely past its `maxDurationSec`.
   */
  async run(hardDeadlineMs?: number): Promise<void> {
    try {
      while (!this.kill.killed && (hardDeadlineMs === undefined || Date.now() < hardDeadlineMs)) {
        if (hardDeadlineMs === undefined) {
          await this.tick();
        } else {
          // Bound the tick by the hard deadline. A request queued on an exhausted
          // HTTP pool (undici) can hang past its own timeout — un-abortable — which
          // would otherwise keep this loop (and the run's Promise.all) open forever
          // and let the load run past its cap. Race the tick against the remaining
          // wall-clock so run() ALWAYS returns by the deadline; a still-pending tick
          // is abandoned (its sample just never lands).
          const remaining = hardDeadlineMs - Date.now();
          if (remaining <= 0) break;
          let timer: ReturnType<typeof setTimeout>;
          const bound = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
            timer.unref?.();
          });
          await Promise.race([this.tick().finally(() => clearTimeout(timer)), bound]);
          if (Date.now() >= hardDeadlineMs) break;
        }
        await this.sleep(this.intervalMs);
      }
    } finally {
      // Release the dedicated pool's sockets when the probe stops. `destroy()`,
      // not `close()`: when the run ends by the hard deadline a tick may still be
      // in-flight against a never-responding target — `close()` would wait for it
      // and hang past the deadline, defeating the very bound run() guarantees.
      // `destroy()` aborts any in-flight request and closes immediately.
      await this.dispatcher.destroy().catch(() => undefined);
    }
  }

  private async tick(): Promise<void> {
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let ok = false;
    let status = 0;
    let latencyMs = 0;
    let quality: ProbeQuality | undefined;
    try {
      const checks = await Promise.all(
        this.urls.map(async (url) => {
          let result: {
            ok: boolean;
            status: number;
            latencyMs: number;
            quality?: ProbeQuality;
            headers?: Headers;
            body?: ArrayBuffer;
          };
          try {
            result = this.remote
              ? await this.acquireRemote(ac.signal, t0, url)
              : await this.acquireLocal(ac.signal, t0, url);
          } catch {
            result = { ok: false, status: 0, latencyMs: performance.now() - t0 };
          }
          if (result.quality) this.qualities.push(result.quality);
          const counts = this.endpointCounts.get(url) ?? { samples: 0, available: 0 };
          counts.samples++;
          if (result.ok) counts.available++;
          this.endpointCounts.set(url, counts);
          this.captureHeadersOnChange(result.status, result.headers);
          if (result.status >= 400 && result.body)
            this.captureEdgeError(result.status, result.body);
          return result;
        }),
      );
      // One cycle is healthy only if every configured functional check succeeds.
      ok = checks.every((r) => r.ok);
      status = (checks.find((r) => r.status >= 500) ?? checks.find((r) => !r.ok) ?? checks[0])
        .status;
      latencyMs = Math.max(...checks.map((r) => r.latencyMs));
      quality = checks.find((r) => !r.ok)?.quality ?? checks[0].quality;
    } catch {
      ok = false;
      latencyMs = performance.now() - t0; // time to failure (timeout / network)
      this.captureHeadersOnChange(0, undefined);
    } finally {
      clearTimeout(timer);
    }
    const sample: ProbeSample = {
      at: Date.now(),
      ok,
      status,
      latencyMs,
      ...(quality ? { quality } : {}),
    };
    this.samples.push(sample);
    this.evaluateAutoKill(sample);
  }

  /** Local vantage: direct measurement from this process (the default). */
  private async acquireLocal(
    signal: AbortSignal,
    t0: number,
    url = this.url,
  ): Promise<{
    ok: boolean;
    status: number;
    latencyMs: number;
    headers?: Headers;
    body?: ArrayBuffer;
  }> {
    // Dedicated dispatcher (see `dispatcher` field) so a saturated generator pool
    // can never starve the probe.
    const res = await pooledFetch(url, {
      signal,
      dispatcher: this.dispatcher,
      redirect: 'manual',
    });
    // TTFB: measured the moment response headers arrive, BEFORE draining the body
    // — a measure of the server's responsiveness, not of the response size.
    const latencyMs = performance.now() - t0;
    // Drain the body (not timed) to release the socket.
    const bytes = await readBoundedBody(
      res.body as unknown as ReadableStream<Uint8Array>,
      IO_LIMITS.responseBytes,
      res.status >= 400,
      MAX_EDGE_BODY_BYTES,
    );
    const body = bytes.buffer as ArrayBuffer;
    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      headers: res.headers as unknown as Headers,
      body,
    };
  }

  /**
   * Remote vantage: ask the read-only probe agent to GET the target and report
   * what IT saw — availability/latency/status measured from the agent's source
   * IP. Response headers and a bounded error-body slice are forwarded so posture
   * / edge-error inference still work. A transport or agent-side failure is a
   * failed measurement (ok:false), never trusted as a target-outage signal.
   */
  private async acquireRemote(
    signal: AbortSignal,
    t0: number,
    url = this.url,
  ): Promise<{
    ok: boolean;
    status: number;
    latencyMs: number;
    quality?: ProbeQuality;
    headers?: Headers;
    body?: ArrayBuffer;
  }> {
    const remote = this.remote!;
    const challenge = probeChallenge();
    const res = await pooledFetch(remote.agentUrl, {
      method: 'POST',
      redirect: 'error',
      signal,
      dispatcher: this.dispatcher,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${remote.token}`,
      },
      body: JSON.stringify({
        url,
        timeoutMs: this.timeoutMs,
        schema: challenge.schema,
        requestId: challenge.requestId,
      }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: 0, latencyMs: performance.now() - t0 };
    }
    const j = JSON.parse(
      new TextDecoder().decode(
        await readBoundedBody(res.body as unknown as ReadableStream<Uint8Array>, 64 * 1024),
      ),
    ) as {
      ok?: boolean;
      status?: number;
      latencyMs?: number;
      headers?: Record<string, string>;
      bodySlice?: string;
    } | null;
    validateProbeFreshness(j, challenge);
    const verified = validateRemoteSample(j, this.timeoutMs);
    if (!j) throw new Error('Invalid remote probe sample');
    const headers = j.headers ? new Headers(j.headers) : undefined;
    let body: ArrayBuffer | undefined;
    if (j.bodySlice) {
      const u8 = new TextEncoder().encode(j.bodySlice);
      body = u8.buffer.slice(0, u8.byteLength);
    }
    return {
      ...verified,
      headers,
      body,
    };
  }

  /** Snapshot response headers the first time a new status *class* is seen (up to
   *  the cap), so a WAF/CDN challenge that only appears UNDER LOAD is captured —
   *  not just the first few healthy responses. */
  private captureHeadersOnChange(status: number, headers?: Headers): void {
    const cls = statusClass(status);
    const changed = cls !== this.lastStatusClass;
    this.lastStatusClass = cls;
    if (!changed || !headers || this.headerSnapshots.length >= MAX_HEADER_SNAPSHOTS) return;
    const snap: Record<string, string> = {};
    headers.forEach((v, k) => {
      snap[k] = v;
    });
    this.headerSnapshots.push(snap);
  }

  /** Decode a bounded slice of an error response body and, if it is an
   *  edge-served error page, keep the signal (deduped by status+layer, capped). */
  private captureEdgeError(status: number, buf: ArrayBuffer): void {
    if (this.edgeErrorSignals.length >= MAX_EDGE_ERRORS) return;
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: false }).decode(
        buf.byteLength > MAX_EDGE_BODY_BYTES ? buf.slice(0, MAX_EDGE_BODY_BYTES) : buf,
      );
    } catch {
      return;
    }
    const signal = detectEdgeError(status, body);
    if (!signal) return;
    // One entry per distinct (status, layer) — enough evidence, no flooding.
    if (this.edgeErrorSignals.some((e) => e.status === signal.status && e.layer === signal.layer)) {
      return;
    }
    this.edgeErrorSignals.push(signal);
  }

  /** Edge-served error pages captured during the run (origin buckle / rate-limit
   *  / challenge). Read by the runner onto the run for the report and replay. */
  edgeErrors(): EdgeErrorSignal[] {
    return this.edgeErrorSignals;
  }

  /** Availability / latency over the most recent sliding window. `full` is true
   *  once the probe has been observing for at least a whole window, so a
   *  windowed verdict is never rendered on a partial early sample set. */
  private windowStats(now: number): {
    count: number;
    availPct: number;
    p95: number;
    full: boolean;
  } {
    const from = now - this.limits.windowMs;
    const win = this.samples.filter((s) => s.at >= from);
    const count = win.length;
    if (count === 0) return { count: 0, availPct: 100, p95: 0, full: false };
    const available = win.filter((s) => s.ok).length;
    const lat = win.map((s) => s.latencyMs).sort((a, b) => a - b);
    const full = now - this.samples[0].at >= this.limits.windowMs;
    return { count, availPct: (available / count) * 100, p95: percentile(lat, 95), full };
  }

  private evaluateAutoKill(sample: ProbeSample): void {
    // Generator outcomes never override independent safety thresholds.

    // Level 1a — consecutive unavailability.
    if (sample.ok) {
      this.unavailableSince = null;
    } else {
      this.unavailableSince ??= sample.at;
      if (sample.at - this.unavailableSince >= this.limits.autoKillUnavailableMs) {
        this.kill.trigger('KILLED_AUTO');
        return;
      }
    }

    // Levels 1b / 1c — windowed availability, and opt-in windowed latency. Only
    // once a full window of history exists and it holds enough samples.
    const w = this.windowStats(sample.at);
    if (!w.full || w.count < this.limits.windowMinSamples) return;
    if (w.availPct < this.limits.windowKillAvailPct) {
      this.kill.trigger('KILLED_AUTO');
      return;
    }
    if (this.limits.latencyKillMs > 0 && w.p95 > this.limits.latencyKillMs) {
      this.kill.trigger('KILLED_AUTO');
    }
  }

  /** Graduated verdict: 'critical' once auto-killed or availability is at/below
   *  the kill line, 'degraded' as an early warning, else 'ok'. */
  health(): ProbeHealth {
    if (this.kill.reason === 'KILLED_AUTO') return 'critical';
    const w = this.windowStats(Date.now());
    if (w.count === 0) return 'ok';
    if (w.availPct < this.limits.windowKillAvailPct) return 'critical';
    if (w.availPct < this.limits.degradedAvailPct) return 'degraded';
    if (this.limits.degradedLatencyMs > 0 && w.p95 > this.limits.degradedLatencyMs)
      return 'degraded';
    return 'ok';
  }

  metrics(): ProbeMetrics {
    const total = this.samples.length;
    const available = this.samples.filter((s) => s.ok).length;
    const server5xx = this.samples.filter((s) => s.status >= 500).length;
    const lat = this.samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const w = this.windowStats(Date.now());
    const quality = this.qualities;
    return {
      ...(this.remote
        ? {
            quality: summarizeProbeQuality(quality, total * this.urls.length),
          }
        : {}),
      endpoints: this.urls.map((url) => ({
        url,
        ...(this.endpointCounts.get(url) ?? { samples: 0, available: 0 }),
      })),
      samples: total,
      available,
      errorRate5xx: total ? Number(((server5xx / total) * 100).toFixed(2)) : 0,
      latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99) },
      successful: available,
      health: this.health(),
      windowAvailPct: Number(w.availPct.toFixed(1)),
    };
  }

  /** Infers the target's protection posture from the probe's own responses. */
  posture(): PostureReport {
    return analyzePosture(
      this.headerSnapshots,
      this.samples.map((s) => s.status),
    );
  }

  /** Number of header snapshots captured (exposed for tests / diagnostics). */
  headerSampleCount(): number {
    return this.headerSnapshots.length;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
