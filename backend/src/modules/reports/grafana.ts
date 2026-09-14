/**
 * Server-side Grafana deep-link builder — the backend twin of the frontend's
 * `grafanaDashUrl`. Reports link into the provisioned dashboards (scoped to a
 * target host and an absolute time window) instead of embedding a static SVG, so
 * the graphs a report shows always come from Grafana's live/historical data.
 */

export const GRAFANA_DASHBOARDS = {
  run: 'shieldtest-run',
  resilience: 'shieldtest-resilience',
} as const;
export type GrafanaPlane = keyof typeof GRAFANA_DASHBOARDS;

/**
 * Build a Grafana dashboard deep-link, or `null` when no base URL is configured
 * (then the caller falls back to an inline chart). `fromMs`/`toMs` are epoch
 * milliseconds; omit them for a live window.
 */
export function grafanaLink(
  base: string | undefined,
  plane: GrafanaPlane,
  opts: { target?: string; fromMs?: number; toMs?: number } = {},
): string | null {
  const b = base?.trim();
  if (!b) return null;
  const p = new URLSearchParams();
  p.set('from', opts.fromMs != null ? String(Math.floor(opts.fromMs)) : 'now-30m');
  p.set('to', opts.toMs != null ? String(Math.ceil(opts.toMs)) : 'now');
  if (opts.target) p.set('var-target', opts.target);
  return `${b.replace(/\/+$/, '')}/d/${GRAFANA_DASHBOARDS[plane]}?${p.toString()}`;
}

/** The absolute [from,to] epoch-ms window of a run, padded by 60s each side. */
export function runWindowMs(
  startedAt?: string,
  finishedAt?: string,
): { fromMs?: number; toMs?: number } {
  const from = startedAt ? Date.parse(startedAt) : NaN;
  const to = finishedAt ? Date.parse(finishedAt) : NaN;
  return {
    fromMs: Number.isNaN(from) ? undefined : from - 60_000,
    toMs: Number.isNaN(to) ? undefined : to + 60_000,
  };
}
