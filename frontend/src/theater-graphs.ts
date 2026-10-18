import type { ChartSeries } from './PromChart.js';
import type { RunSample, CampaignRun } from './api.js';
export interface TheaterPanel {
  label: string;
  series: ChartSeries[];
  yRange?: [number, number];
  yFromZero?: boolean;
}

/** Prefer explicit provenance; historical all-zero external samples remain unknown. */
export function hasLiveGenerator(samples: RunSample[]): boolean {
  return samples.some((s) => s.generatorObserved ?? (s.sent > 0 || s.rps > 0));
}

/** Cumulative generator rates and probe observations, shared by live and replay views.
 * Successful responses use their own counter, never sent minus failed (in-flight
 * requests have no successful outcome). No incoming load/mitigation is inferred. */
export function theaterPanels(samples: RunSample[], vector?: string): TheaterPanel[] {
  const avail: [number, number][] = [];
  const p95: [number, number][] = [];
  for (const s of samples) {
    if (s.probeSamples !== 0) avail.push([s.t, s.availPct]);
    if (s.probeSamples !== 0 && s.probeP95 != null) p95.push([s.t, s.probeP95]);
  }
  const availabilityPanel: TheaterPanel = {
    label: 'Legitimate availability (%)',
    yRange: [0, 100],
    series: [{ label: 'probe avail %', points: avail, color: '#10b981' }],
  };

  if (vector === 'http-slowloris' || samples.some((s) => s.sampleUnit === 'connections')) {
    const observed = samples.filter((s) => s.generatorObserved ?? s.sent > 0);
    return [
      {
        label: 'Connections (count)',
        yFromZero: true,
        series: [
          { label: 'opened', points: observed.map((s) => [s.t, s.sent]), color: '#3b82f6' },
          {
            label: 'held',
            points: observed.map((s) => [s.t, s.successful ?? Math.max(0, s.sent - s.failed)]),
            color: '#10b981',
          },
          { label: 'closed', points: observed.map((s) => [s.t, s.failed]), color: '#f59e0b' },
        ],
      },
      availabilityPanel,
      {
        label: 'Legitimate latency p95 (ms)',
        yFromZero: true,
        series: [{ label: 'probe p95', points: p95, color: '#3b82f6' }],
      },
    ];
  }
  if (!hasLiveGenerator(samples)) {
    // External engine: no live generator stream. Show what IS measured live.
    return [
      availabilityPanel,
      {
        label: 'Legitimate latency p95 (ms)',
        yFromZero: true,
        series: [{ label: 'probe p95', points: p95, color: '#3b82f6' }],
      },
    ];
  }

  const offered: [number, number][] = [];
  const origin: [number, number][] = [];
  const absorbed: [number, number][] = [];
  for (const s of samples) {
    if (!(s.generatorObserved ?? (s.sent > 0 || s.rps > 0))) continue;
    const success = s.sent > 0 && s.successful != null ? s.successful / s.sent : undefined;
    offered.push([s.t, s.rps]);
    if (success != null) origin.push([s.t, s.rps * success]);
    absorbed.push([s.t, s.sent > 0 ? (s.failed / s.sent) * 100 : 0]);
  }
  return [
    {
      label: 'Mean offered vs successful-response RPS',
      yFromZero: true,
      series: [
        { label: 'offered', points: offered, color: '#3b82f6' },
        { label: 'successful responses', points: origin, color: '#10b981' },
      ],
    },
    {
      label: 'Generator failures (%)',
      yRange: [0, 100],
      series: [{ label: 'generator failures %', points: absorbed, color: '#f59e0b' }],
    },
    availabilityPanel,
  ];
}

/** The shared x-domain max for the Run-Theater panels: the largest elapsed
 *  second across the samples (never below 1). Every panel is drawn on [0, this]
 *  so they stay aligned and no line is ever plotted past the frame. NOT rounded
 *  — a rounded-down max would clip the last point. Pure, so it is unit-tested. */
export function panelsXMax(samples: RunSample[]): number {
  return Math.max(1, ...samples.map((s) => s.t).filter((t) => Number.isFinite(t) && t >= 0));
}

export interface RunGraph {
  id: string;
  label: string;
  unit: string;
  note: string;
  series: ChartSeries[];
  yRange?: [number, number];
  pointsOnly?: boolean;
  unavailable?: string;
}
export interface GraphContext {
  vector?: string;
  probeUrl?: string;
  configuredRps?: number;
  baselineP95?: number;
  targetTelemetry?: CampaignRun['targetTelemetry'];
  startedAt?: string;
}
const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444'];
const observed = (s: RunSample) => s.generatorObserved ?? (s.sent > 0 || s.rps > 0);
/** Counter deltas require two observed snapshots and monotonic counters. Never
 * turn a reset, missing counter or duplicate timestamp into measured zero. */
export function intervalPoints(
  samples: RunSample[],
  read: (s: RunSample) => number | undefined,
): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i];
    const av = read(a),
      bv = read(b),
      dt = b.t - a.t;
    if (
      observed(a) &&
      observed(b) &&
      av != null &&
      bv != null &&
      Number.isFinite(av) &&
      Number.isFinite(bv) &&
      dt > 0 &&
      bv >= av
    )
      points.push([b.t, (bv - av) / dt]);
  }
  return points;
}
export function buildRunGraphs(input: RunSample[], ctx: GraphContext = {}): RunGraph[] {
  const samples = [
    ...new Map(input.filter((s) => Number.isFinite(s.t) && s.t >= 0).map((s) => [s.t, s])).values(),
  ].sort((a, b) => a.t - b.t);
  const slow =
    ctx.vector === 'http-slowloris' || samples.some((s) => s.sampleUnit === 'connections');
  const series = (label: string, points: [number, number][], n = 0): ChartSeries => ({
    label,
    points,
    color: colors[n],
  });
  const graphs: RunGraph[] = [];
  const load = [
    series(
      'Emitted',
      intervalPoints(samples, (s) => s.sent),
    ),
    series(
      'Successful responses',
      intervalPoints(samples, (s) => s.successful),
      1,
    ),
  ];
  if (ctx.configuredRps != null && samples.length)
    load.push(
      series(
        'Configured ceiling (not received load)',
        [
          [samples[0].t, ctx.configuredRps],
          [samples.at(-1)!.t, ctx.configuredRps],
        ],
        2,
      ),
    );
  graphs.push({
    id: 'load',
    label: 'Load per interval',
    unit: 'req/s',
    note: 'Differences between cumulative counters divided by elapsed time. Successes are finalized responses, not origin receipts. The configured ceiling is not a phase-by-phase demand measurement.',
    series: slow ? [] : load,
    unavailable: slow
      ? 'This scenario counts connections, not HTTP request throughput.'
      : !load[0].points.length
        ? 'Two observed generator snapshots are required.'
        : undefined,
  });

  const urls = ctx.probeUrl;
  const probe = (s: RunSample) =>
    urls
      ? s.probeEndpoints?.find((e) => e.url === urls)
      : { samples: s.probeSamples, available: s.probeAvailable };
  const exact = samples.some((s) => probe(s)?.available != null);
  const availability: [number, number][] = [];
  let previous: { samples: number; available: number } | undefined;
  let previousSamples: number | undefined;
  for (const s of samples) {
    const p = probe(s);
    if (p?.samples == null || p.samples <= 0 || p.samples === previousSamples) continue;
    previousSamples = p.samples;
    if (exact && p.available != null) {
      if (previous && p.samples > previous.samples && p.available >= previous.available) {
        const success = p.available - previous.available,
          count = p.samples - previous.samples;
        if (success <= count) availability.push([s.t, (100 * success) / count]);
      }
      previous = { samples: p.samples, available: p.available };
    } else if (!urls && !exact && Number.isFinite(s.availPct)) availability.push([s.t, s.availPct]);
  }
  graphs.push({
    id: 'availability',
    label: 'Monitored checks',
    unit: '%',
    series: [series('Successful checks', availability, 1)],
    pointsOnly: true,
    yRange: [0, 100],
    note: exact
      ? 'Each point represents newly completed checks since the previous observation, not continuous uptime. Gaps between checks are unobserved; HTTP status alone is not a functional transaction.'
      : 'Historical cumulative success ratio. Individual check outcomes were not retained; no continuous uptime is established.',
    unavailable: availability.length
      ? undefined
      : 'No completed probe observation interval is available.',
  });
  const latency = ['p50', 'p95', 'p99']
    .map((key, i) =>
      series(
        key,
        samples
          .filter(
            (s, index) =>
              s.probeSamples != null &&
              s.probeSamples > 0 &&
              (index === 0 || s.probeSamples !== samples[index - 1].probeSamples),
          )
          .flatMap((s) => {
            const value =
              s.probeLatencyMs?.[key as 'p50' | 'p95' | 'p99'] ??
              (key === 'p95' ? s.probeP95 : undefined);
            return value != null && Number.isFinite(value)
              ? [[s.t, value] as [number, number]]
              : [];
          }),
        i,
      ),
    )
    .filter((s) => s.points.length);
  if (
    ctx.baselineP95 != null &&
    samples.length &&
    !samples.some((s) => (s.probeEndpoints?.length ?? 0) > 1)
  )
    latency.push(
      series(
        'Pre-load baseline p95',
        [
          [samples[0].t, ctx.baselineP95],
          [samples.at(-1)!.t, ctx.baselineP95],
        ],
        3,
      ),
    );
  graphs.push({
    id: 'latency',
    label: 'Probe latency',
    unit: 'ms',
    series: latency,
    note: 'Cumulative probe percentiles, updated only after new observations. These are not per-second percentiles. Small sample counts limit tail-latency conclusions; missing percentiles remain absent. A single-URL baseline is omitted for multi-URL probe aggregates.',
    unavailable: latency.some((s) => s.label !== 'Pre-load baseline p95' && s.points.length)
      ? undefined
      : 'Probe latency samples are not available.',
  });
  const errors: [number, number][] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i];
    if (!observed(a) || !observed(b) || b.t <= a.t || a.successful == null || b.successful == null)
      continue;
    const bad = b.failed - a.failed,
      ok = b.successful - a.successful;
    if (bad >= 0 && ok >= 0 && bad + ok > 0) errors.push([b.t, (100 * bad) / (bad + ok)]);
  }
  graphs.push({
    id: 'errors',
    label: 'Finalized request failures',
    unit: '%',
    series: slow ? [] : [series('Failures / finalized outcomes', errors, 2)],
    yRange: [0, 100],
    note: 'Failed outcomes divided by successful plus failed outcomes in the same interval. In-flight requests are excluded. HTTP errors and transport errors require additional categorization; failures do not prove filtering.',
    unavailable: slow
      ? 'Use the connection-count graph for this scenario.'
      : errors.length
        ? undefined
        : 'Two observed snapshots with finalized outcomes are required.',
  });
  const statuses = ['2', '3', '4', '5'].map((prefix, i) =>
    series(
      prefix + 'xx',
      intervalPoints(samples, (s) =>
        s.statusCounts
          ? Object.entries(s.statusCounts).reduce(
              (n, [k, v]) => n + (k.startsWith(prefix) ? v : 0),
              0,
            )
          : undefined,
      ),
      i,
    ),
  );
  graphs.push({
    id: 'status',
    label: 'HTTP response classes',
    unit: 'responses/s',
    series: slow ? [] : statuses,
    note: 'Changes in observed HTTP status counters. Transport errors have no HTTP status and are not included.',
    unavailable: slow
      ? 'No HTTP response-class series for connection-hold scenarios.'
      : statuses.some((s) => s.points.length)
        ? undefined
        : 'Historical HTTP status snapshots were not recorded.',
  });
  graphs.push({
    id: 'connections',
    label: 'Connections',
    unit: 'count',
    series: slow ? (theaterPanels(samples, ctx.vector)[0]?.series ?? []) : [],
    note: 'Cumulative opened, currently held and closed connections as reported by the connection generator. Not HTTP throughput.',
    unavailable: slow ? undefined : 'This run does not report a connection-hold scenario.',
  });
  graphs.push({
    id: 'quality',
    label: 'Observation coverage',
    unit: 'count / seconds',
    series: [
      series(
        'Completed probe cycles',
        samples.filter((s) => s.probeSamples != null).map((s) => [s.t, s.probeSamples!]),
      ),
      {
        ...series(
          'Retained tick interval (s)',
          samples.slice(1).map((s, i) => [s.t, s.t - samples[i].t]),
          2,
        ),
        axis: 'right',
      },
    ],
    note: 'Probe observations (left axis) and elapsed time between retained timeline points (right axis). A gap is missing observation, not service failure. Historical retention may be coarser than live sampling.',
  });
  const start = ctx.startedAt ? Date.parse(ctx.startedAt) : NaN;
  const target = (key: 'cpuPct' | 'nicRxMbps' | 'nicTxMbps' | 'conntrack'): [number, number][] =>
    (ctx.targetTelemetry ?? []).flatMap((s) => {
      const t = (Date.parse(s.at) - start) / 1000,
        v = s[key];
      return Number.isFinite(t) && t >= 0 && v != null && Number.isFinite(v) ? [[t, v]] : [];
    });
  for (const [id, label, unit, keys] of [
    ['target-cpu', 'Target CPU', '%', ['cpuPct']],
    ['target-network', 'Target network', 'Mbit/s', ['nicRxMbps', 'nicTxMbps']],
    ['target-connections', 'Target connection tracking', 'count', ['conntrack']],
  ] as const) {
    const lines = keys.map((key, i) => series(key, target(key), i));
    graphs.push({
      id,
      label,
      unit,
      series: lines,
      note: 'Independent target-host telemetry aligned to the recorded generator start; NIC traffic includes other host activity and is not proof of received campaign traffic.',
      unavailable: lines.some((s) => s.points.length)
        ? undefined
        : 'No correlated target-host telemetry was recorded.',
    });
  }
  for (const [id, label, reason] of [
    [
      'received',
      'Received load / filtering',
      'Independent protection and origin counters are required. Emitted or successful HTTP traffic cannot substitute for these measurements.',
    ],
    [
      'generator-health',
      'Generator resources',
      'CPU, memory and throttling history are not retained in this run timeline.',
    ],
    [
      'fleet',
      'Agents and sites',
      'Historical per-agent/site series are not retained here; use Fleet live status for current observations.',
    ],
    [
      'recovery',
      'Outage / recovery',
      'Post-injection functional observations are required. A pre-step recovery check is not a post-run recovery measurement.',
    ],
  ])
    graphs.push({ id, label, unit: '—', series: [], note: reason, unavailable: reason });
  return graphs;
}
export function graphCsv(graph: RunGraph): string {
  const escape = (value: unknown) =>
    '"' +
    String(value)
      .replace(/^[=+@-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  return [
    'elapsed_seconds,series,value,unit',
    ...graph.series.flatMap((s) =>
      s.points.map(([t, v]) =>
        [
          t,
          s.label,
          v,
          graph.unit === 'count / seconds'
            ? s.axis === 'right'
              ? 'seconds'
              : 'count'
            : graph.unit,
        ]
          .map(escape)
          .join(','),
      ),
    ),
  ].join('\r\n');
}
