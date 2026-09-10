/**
 * Minimal, read-only Prometheus range-query client — the backend half of the
 * app-native charts (option B): the app queries the same Prometheus that feeds
 * Grafana, so a native chart shows identical data without embedding Grafana.
 *
 * Config-driven and fail-soft: with no `PROMETHEUS_URL` (or an unreachable one)
 * it returns `unavailable`/`error` and the UI simply hides the native chart —
 * the app degrades gracefully rather than breaking. Prometheus lives loopback on
 * the monitoring host, so in production `PROMETHEUS_URL` points at a VPS1→VPS2
 * tunnel; unset in dev/tests.
 */

export interface PromSeries {
  labels: Record<string, string>;
  /** [unix seconds, value] pairs. */
  points: [number, number][];
}

export interface PromResult {
  status: 'ok' | 'unavailable' | 'error';
  series: PromSeries[];
  error?: string;
}

export interface PromRange {
  startS: number;
  endS: number;
  stepS: number;
}

/** The slice of `fetch` we use — injectable so the query path is unit-testable. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface QueryOpts {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface PromApiShape {
  status?: string;
  error?: string;
  data?: { result?: { metric?: Record<string, string>; values?: [number, string][] }[] };
}

/**
 * Runs a Prometheus `query_range`. Never throws: an absent base URL yields
 * `unavailable`, a transport/parse failure yields `error`.
 */
export async function queryRange(
  base: string | undefined,
  query: string,
  range: PromRange,
  opts: QueryOpts = {},
): Promise<PromResult> {
  if (!base) return { status: 'unavailable', series: [] };
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return { status: 'unavailable', series: [] };

  const qs = new URLSearchParams({
    query,
    start: String(range.startS),
    end: String(range.endS),
    step: String(range.stepS),
  });
  const url = `${base.replace(/\/+$/, '')}/api/v1/query_range?${qs.toString()}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return { status: 'error', series: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as PromApiShape;
    if (body.status !== 'success') {
      return { status: 'error', series: [], error: body.error ?? 'prometheus error' };
    }
    const series: PromSeries[] = (body.data?.result ?? []).map((r) => ({
      labels: r.metric ?? {},
      points: (r.values ?? []).map(([t, v]) => [Number(t), Number(v)] as [number, number]),
    }));
    return { status: 'ok', series };
  } catch (err) {
    return { status: 'error', series: [], error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
