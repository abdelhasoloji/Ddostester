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

import { analyzePosture } from '../posture/analyze.js';
import type { PostureReport } from '../posture/analyze.js';
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
  /** Last observed status class, so we snapshot headers on a *transition*. */
  private lastStatusClass: string | null = null;
  private readonly limits: ProbeLimits;

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
    while (!this.kill.killed && (hardDeadlineMs === undefined || Date.now() < hardDeadlineMs)) {
      await this.tick();
      await this.sleep(this.intervalMs);
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
      const res = await fetch(this.url, { signal: ac.signal });
      // TTFB: measured the moment response headers arrive, BEFORE draining the
      // body. This keeps the latency metric a measure of the server's
      // responsiveness rather than of the response size / our own bandwidth.
      latencyMs = performance.now() - t0;
      status = res.status;
      ok = res.ok;
      this.captureHeadersOnChange(status, res.headers);
      // Drain (and discard) the body to release the socket; not timed.
      await res.arrayBuffer().catch(() => undefined);
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
