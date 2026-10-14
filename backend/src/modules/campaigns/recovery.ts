import {
  summarizeProbeQuality,
  type ProbeQuality,
  type ProbeQualitySummary,
} from '../probe/quality.js';
import { remoteProbeQualityReasons } from '../reports/confidence.js';
import { sampleRemoteProbe } from '../probe/remote.js';
import type { RemoteProbeConfig } from '../../config/limits.js';
import { readBoundedBody } from '../../util/http-body.js';
import { IO_LIMITS } from '../../config/limits.js';
/**
 * Between-wave recovery gate for a suite. After one step's bounded load settles,
 * the next wave should not start until the target is reachable again — this both
 * measures how long the target takes to recover and avoids piling load on a
 * still-down origin. Purely a legitimate reachability check (a few GETs); it
 * emits no attack load. Bounded, so a suite can never hang here.
 */

export interface RecoveryOptions {
  remote?: RemoteProbeConfig;
  /** Give up waiting after this long (default 90s). */
  maxWaitMs?: number;
  /** Delay between checks (default 2s). */
  intervalMs?: number;
  /** Consecutive healthy checks required to call the target "recovered" (default 2). */
  needed?: number;
  /** Per-check request timeout (default 4s). */
  requestTimeoutMs?: number;
  /** Abort early (e.g. the suite was cancelled). */
  isCancelled?: () => boolean;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RecoveryResult {
  /** Remote reachability is not sufficient when diagnostics/observations are uncertain. */
  verified?: boolean;
  quality?: ProbeQualitySummary;
  observation?: {
    vantage: 'remote';
    receivedSamples: number;
    missingSamples: number;
    complete: boolean;
  };
  available: boolean;
  waitedMs: number;
  checks: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `url` until it answers healthily `needed` times in a row (reachable and
 * not 5xx) or `maxWaitMs` elapses. Returns whether the target recovered and how
 * long it took — never throws.
 */
export async function waitForTargetAvailable(
  url: string,
  opts: RecoveryOptions = {},
): Promise<RecoveryResult> {
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const needed = opts.needed ?? 2;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 4_000;
  const isCancelled = opts.isCancelled ?? (() => false);
  const doFetch = opts.fetchImpl ?? fetch;

  const start = performance.now();
  let consecutive = 0;
  let checks = 0;
  let received = 0;
  const diagnostics: ProbeQuality[] = [];
  const result = (available: boolean): RecoveryResult => {
    const quality = opts.remote ? summarizeProbeQuality(diagnostics, checks) : undefined;
    const complete = checks > 0 && received === checks;
    return {
      available,
      waitedMs: performance.now() - start,
      checks,
      ...(quality
        ? {
            quality,
            observation: {
              vantage: 'remote' as const,
              receivedSamples: received,
              missingSamples: checks - received,
              complete,
            },
            verified: complete && remoteProbeQualityReasons(quality).length === 0,
          }
        : {}),
    };
  };
  while (!isCancelled() && performance.now() - start < maxWaitMs) {
    checks += 1;
    let ok = false;
    const ac = new AbortController();
    const remainingMs = Math.max(1, maxWaitMs - (performance.now() - start));
    const boundedTimeout = Math.min(requestTimeoutMs, remainingMs);
    const timer = setTimeout(() => ac.abort(), boundedTimeout);
    try {
      if (opts.remote) {
        const sample = await sampleRemoteProbe(opts.remote, url, boundedTimeout, ac.signal);
        received++;
        if (sample.quality) diagnostics.push(sample.quality);
        ok = sample.ok;
      } else {
        const res = await doFetch(url, { signal: ac.signal, redirect: 'manual' });
        // Reachable and not erroring: a 5xx means the origin is still struggling,
        // a connection failure throws. 2xx–4xx = the target is up.
        ok = res.status < 500;
        await readBoundedBody(res.body, IO_LIMITS.responseBytes, false); // drain to free the socket
      }
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    consecutive = ok ? consecutive + 1 : 0;
    if (consecutive >= needed && performance.now() - start < maxWaitMs) return result(true);
    const remaining = Math.max(0, maxWaitMs - (performance.now() - start));
    if (remaining <= intervalMs) {
      // Timers round fractional milliseconds down. Do not start another check
      // when this interval was already clipped to the end of the gate budget.
      await sleep(remaining);
      break;
    }
    await sleep(intervalMs);
  }
  return result(false);
}
