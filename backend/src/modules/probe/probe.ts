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
import { analyzePosture } from '../posture/analyze.js';
import type { PostureReport } from '../posture/analyze.js';
import { detectEdgeError } from '../posture/edge-error.js';
import type { EdgeErrorSignal } from '../posture/edge-error.js';
import { percentile } from '../../engine/stats.js';
import { PROBE_LIMITS } from '../../config/limits.js';
import type { ProbeLimits } from '../../config/limits.js';

export interface ProbeSample {
  at: number;
  ok: boolean;
  status: number;
  /** Time to response headers (TTFB) in ms, or time-to-failure on error. */
  latencyMs: number;
}

/** Graduated probe verdict: green / amber / red. */
export type ProbeHealth = 'ok' | 'degraded' | 'critical';

export interface ProbeMetrics {
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

  /**
   * Optional corroboration hook: returns true when the LOAD GENERATOR is
   * currently getting successful responses from the SAME target. When it is, a
   * probe reading of "unavailable" is not a target outage — it is the probe's
   * handful of connections losing the race to the flood at the target (observed
   * live: a target serving 6000+ 2xx while the 4-connection probe read 0/4, which
   * auto-killed the run and scored it WRS 41 D). In that state we must NOT
   * auto-kill on availability — the target is provably up. Set by the runner.
   */
  private generatorSucceeding?: () => boolean;
  /** Wire the live generator-health signal (see `generatorSucceeding`). */
  watchGenerator(fn: () => boolean): void {
    this.generatorSucceeding = fn;
  }

  constructor(
    private readonly url: string,
    private readonly kill: KillSwitch,
    private readonly intervalMs = PROBE_LIMITS.intervalMs,
    private readonly timeoutMs = PROBE_LIMITS.timeoutMs,
    limits: Partial<ProbeLimits> = {},
  ) {
    // Positional interval/timeout win (back-compat with existing callers/tests);
    // everything else comes from the merged limits.
    this.limits = { ...PROBE_LIMITS, ...limits, intervalMs, timeoutMs };
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
    try {
      // Dedicated dispatcher (see `dispatcher` field) so a saturated generator
      // pool can never starve the probe.
      const res = await pooledFetch(this.url, { signal: ac.signal, dispatcher: this.dispatcher });
      // TTFB: measured the moment response headers arrive, BEFORE draining the
      // body. This keeps the latency metric a measure of the server's
      // responsiveness rather than of the response size / our own bandwidth.
      latencyMs = performance.now() - t0;
      status = res.status;
      ok = res.ok;
      this.captureHeadersOnChange(status, res.headers as unknown as Headers);
      // Drain the body to release the socket (not timed). On an ERROR status we
      // also decode a bounded slice to detect an edge-served error page (the
      // origin buckling behind a healthy edge, a rate-limit or a challenge).
      const buf = await res.arrayBuffer().catch(() => undefined);
      if (status >= 400 && buf) this.captureEdgeError(status, buf);
    } catch {
      ok = false;
      latencyMs = performance.now() - t0; // time to failure (timeout / network)
      this.captureHeadersOnChange(0, undefined);
    } finally {
      clearTimeout(timer);
    }
    const sample: ProbeSample = { at: Date.now(), ok, status, latencyMs };
    this.samples.push(sample);
    this.evaluateAutoKill(sample);
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
    // Corroboration (PF1): if the load generator is concurrently getting
    // successful responses from the same target, the target is provably UP — a
    // probe "unavailable" here is the probe losing the connection race to the
    // flood, not an outage. In that state NO auto-kill fires (it would stop a run
    // the target is coping with and score it as a failure) and the
    // consecutive-unavailable timer is not allowed to accrue. Samples are still
    // recorded for reporting; only the KILL is suppressed.
    const genOk = this.generatorSucceeding?.() ?? false;
    // Level 1a — consecutive unavailability.
    if (sample.ok || genOk) {
      this.unavailableSince = null;
    } else {
      this.unavailableSince ??= sample.at;
      if (sample.at - this.unavailableSince >= this.limits.autoKillUnavailableMs) {
        this.kill.trigger('KILLED_AUTO');
        return;
      }
    }
    if (genOk) return; // target provably serving — never kill on availability/latency
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
    return {
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
