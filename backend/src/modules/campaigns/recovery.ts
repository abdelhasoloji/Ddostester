/**
 * Between-wave recovery gate for a suite. After one step's bounded load settles,
 * the next wave should not start until the target is reachable again — this both
 * measures how long the target takes to recover and avoids piling load on a
 * still-down origin. Purely a legitimate reachability check (a few GETs); it
 * emits no attack load. Bounded, so a suite can never hang here.
 */

export interface RecoveryOptions {
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

  const start = Date.now();
  let consecutive = 0;
  let checks = 0;
  while (!isCancelled() && Date.now() - start < maxWaitMs) {
    checks += 1;
    let ok = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), requestTimeoutMs);
    try {
      const res = await doFetch(url, { signal: ac.signal });
      // Reachable and not erroring: a 5xx means the origin is still struggling,
      // a connection failure throws. 2xx–4xx = the target is up.
      ok = res.status < 500;
      await res.arrayBuffer().catch(() => undefined); // drain to free the socket
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    consecutive = ok ? consecutive + 1 : 0;
    if (consecutive >= needed) return { available: true, waitedMs: Date.now() - start, checks };
    await sleep(intervalMs);
  }
  return { available: false, waitedMs: Date.now() - start, checks };
}
