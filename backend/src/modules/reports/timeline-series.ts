/** Pure retained-evidence transformations shared by Theater and printed reports.
 * Nulls are observation gaps, never measured zero or proof of an outage. */
export interface TimelineSample {
  t: number;
  sent: number;
  failed: number;
  successful?: number;
  rps: number;
  generatorObserved?: boolean;
  probeSamples?: number;
  probeAvailable?: number;
  availPct: number;
  probeEndpoints?: { url: string; samples: number; available: number }[];
}
export interface TimelineDatum {
  t: number;
  y: number | null;
}
export const generatorObserved = (s: TimelineSample) =>
  s.generatorObserved ?? (s.sent > 0 || s.rps > 0);
export function cleanTimeline<T extends TimelineSample>(input: T[]): T[] {
  return [
    ...new Map(input.filter((s) => Number.isFinite(s.t) && s.t >= 0).map((s) => [s.t, s])).values(),
  ].sort((a, b) => a.t - b.t);
}
const counterObserved = (s: TimelineSample) => s.generatorObserved ?? s.sent > 0;
const counter = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n >= 0;
export function counterIntervals<T extends TimelineSample>(
  samples: T[],
  read: (s: T) => number | undefined,
): TimelineDatum[] {
  return samples.map((b, i) => {
    const a = samples[i - 1];
    if (!a || !counterObserved(a) || !counterObserved(b)) return { t: b.t, y: null };
    const av = read(a),
      bv = read(b),
      dt = b.t - a.t;
    return { t: b.t, y: counter(av) && counter(bv) && bv >= av && dt > 0 ? (bv - av) / dt : null };
  });
}
export function finalizedFailureIntervals(samples: TimelineSample[]): TimelineDatum[] {
  return samples.map((b, i) => {
    const a = samples[i - 1];
    if (
      !a ||
      !counterObserved(a) ||
      !counterObserved(b) ||
      b.t <= a.t ||
      !counter(a.failed) ||
      !counter(b.failed) ||
      !counter(a.successful) ||
      !counter(b.successful)
    )
      return { t: b.t, y: null };
    const bad = b.failed - a.failed,
      ok = b.successful - a.successful;
    return { t: b.t, y: bad >= 0 && ok >= 0 && bad + ok > 0 ? (100 * bad) / (bad + ok) : null };
  });
}
export function probeCheckIntervals(
  samples: TimelineSample[],
  url?: string,
): { exact: boolean; rows: TimelineDatum[] } {
  const read = (s: TimelineSample) =>
    url
      ? s.probeEndpoints?.find((p) => p.url === url)
      : { samples: s.probeSamples, available: s.probeAvailable };
  const exact = samples.some((s) => read(s)?.available != null);
  // Counters are scoped to this run. The first retained snapshot includes real
  // completed checks since its zero origin; do not silently omit those outcomes.
  let previous = { samples: 0, available: 0 };
  let lastCount: number | undefined;
  const rows = samples.map((s) => {
    const p = read(s);
    let y: number | null = null;
    if (exact && p && counter(p.samples) && counter(p.available) && p.available <= p.samples) {
      if (previous && p.samples > previous.samples && p.available >= previous.available) {
        const count = p.samples - previous.samples,
          ok = p.available - previous.available;
        if (ok <= count) y = (100 * ok) / count;
      }
      previous = { samples: p.samples, available: p.available };
    } else if (
      !exact &&
      !url &&
      p?.samples !== 0 &&
      (p?.samples == null || p.samples !== lastCount) &&
      Number.isFinite(s.availPct)
    )
      y = s.availPct;
    lastCount = p?.samples;
    return { t: s.t, y };
  });
  return { exact, rows };
}
export function plotSeries(rows: TimelineDatum[]): {
  points: [number, number][];
  breakBefore: number[];
} {
  const points: [number, number][] = [];
  const breakBefore: number[] = [];
  let gap = false;
  for (const row of rows) {
    if (row.y == null) {
      gap = points.length > 0;
      continue;
    }
    if (gap) breakBefore.push(row.t);
    points.push([row.t, row.y]);
    gap = false;
  }
  return { points, breakBefore };
}
