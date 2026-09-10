/**
 * Named, server-controlled series for the app-native charts. The frontend asks
 * for a series by KEY (never raw PromQL), so the app never proxies an arbitrary
 * query to Prometheus — no injection, no SSRF-via-query, and the set of things
 * the app can plot stays a reviewed, bounded catalogue.
 */

export interface SeriesLine {
  label: string;
  /** Builds the PromQL for a given (sanitised) target host. */
  expr: (target: string) => string;
}

export interface SeriesDef {
  title: string;
  /** Grafana-style unit hint for the client (reqps, percent, ms, short). */
  unit: string;
  /** Whether a target host is required (per-run series) or optional (global). */
  needsTarget: boolean;
  lines: SeriesLine[];
}

/** Strip anything that could break out of a PromQL `{label="..."}` value. */
export function sanitizeTarget(target: string): string {
  return target.replace(/[^A-Za-z0-9._:-]/g, '');
}

const T = (t: string) => `{target="${sanitizeTarget(t)}"}`;

export const SERIES_CATALOG: Record<string, SeriesDef> = {
  run_rps: {
    title: 'Live RPS — offered vs reached origin',
    unit: 'reqps',
    needsTarget: true,
    lines: [
      { label: 'offered', expr: (t) => `shieldtest_run_live_offered_rps${T(t)}` },
      { label: 'reached origin', expr: (t) => `shieldtest_run_live_origin_rps${T(t)}` },
    ],
  },
  run_absorbed: {
    title: 'Absorbed by edge (%)',
    unit: 'percent',
    needsTarget: true,
    lines: [{ label: 'absorbed %', expr: (t) => `shieldtest_run_live_absorbed_ratio${T(t)}*100` }],
  },
  eventloop_lag: {
    title: 'Event-loop lag (measurement confidence)',
    unit: 'ms',
    needsTarget: false,
    lines: [
      { label: 'mean', expr: () => `shieldtest_eventloop_lag_ms` },
      { label: 'p99', expr: () => `shieldtest_eventloop_lag_p99_ms` },
    ],
  },
  wrs: {
    title: 'WRS over time',
    unit: 'short',
    needsTarget: false,
    lines: [
      {
        label: 'WRS',
        expr: (t) =>
          t ? `shieldtest_wrs_last{target="${sanitizeTarget(t)}"}` : `shieldtest_wrs_last`,
      },
    ],
  },
};

export interface ResolvedSeries {
  def: SeriesDef;
  lines: { label: string; promql: string }[];
}

/**
 * Resolves a catalogue key (+ optional target) into concrete PromQL lines, or
 * null when the key is unknown or a per-run series is missing its target.
 */
export function resolveSeries(name: string, target?: string): ResolvedSeries | null {
  const def = SERIES_CATALOG[name];
  if (!def) return null;
  const t = (target ?? '').trim();
  if (def.needsTarget && !t) return null;
  return { def, lines: def.lines.map((l) => ({ label: l.label, promql: l.expr(t) })) };
}
