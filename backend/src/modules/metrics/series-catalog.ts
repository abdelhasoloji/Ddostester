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
    title: 'Live RPS — offered vs successful responses',
    unit: 'reqps',
    needsTarget: true,
    lines: [
      { label: 'offered', expr: (t) => `shieldtest_run_live_offered_rps${T(t)}` },
      { label: 'successful responses', expr: (t) => `shieldtest_run_live_successful_rps${T(t)}` },
    ],
  },
  run_absorbed: {
    title: 'Generator failures (%)',
    unit: 'percent',
    needsTarget: true,
    lines: [
      { label: 'generator failures %', expr: (t) => `shieldtest_run_live_failed_ratio${T(t)}*100` },
    ],
  },
  run_availability: {
    title: 'Legitimate availability (%)',
    unit: 'percent',
    needsTarget: true,
    lines: [{ label: 'probe avail %', expr: (t) => `shieldtest_run_live_probe_avail_pct${T(t)}` }],
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

/** Scoped equivalents of the provisioned DRS Grafana panels. */
export function resolveDrsSeries(
  name: string,
  campaign?: string,
  revision?: string,
): ResolvedSeries | null {
  if (
    !campaign ||
    !revision ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(campaign) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(revision)
  )
    return null;
  const match = `campaign_id="${campaign}",revision_id="${revision}"`;
  const fresh = ` and on(campaign_id,revision_id,run_id,mode,job,instance) (time() - shieldtest_fleet_live_observed_timestamp_seconds{${match}} < 20)`;
  const definitions: Record<
    string,
    { title: string; unit: string; lines: { label: string; promql: string }[] }
  > = {
    drs_score: {
      title: 'DRS score · inspect mode and finalization',
      unit: 'short',
      lines: [{ label: 'DRS score', promql: `shieldtest_drs_score{${match}}` }],
    },
    drs_coverage: {
      title: 'DRS vector coverage',
      unit: 'short',
      lines: ['passed', 'failed', 'unknown'].map((coverage) => ({
        label: coverage,
        promql: `sum(shieldtest_drs_vectors{${match},coverage="${coverage}"})`,
      })),
    },
    drs_agents: {
      title: 'Fleet participation · reported and unknown',
      unit: 'short',
      lines: [
        {
          label: 'reporting',
          promql: `sum(shieldtest_fleet_live_agents_reporting{${match}}${fresh})`,
        },
        { label: 'unknown', promql: `sum(shieldtest_fleet_live_agents_unknown{${match}}${fresh})` },
      ],
    },
  };
  const d = definitions[name];
  return d
    ? { def: { title: d.title, unit: d.unit, needsTarget: false, lines: [] }, lines: d.lines }
    : null;
}
