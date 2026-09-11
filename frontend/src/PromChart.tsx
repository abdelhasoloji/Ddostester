import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { MetricsRange } from './api.js';

/**
 * App-native charts rendered with uPlot — the same engine Grafana uses — so
 * every graph in the app reads like a Grafana panel. `UplotChart` is the shared
 * primitive (multi-series, optional right axis, time or numeric x); `PromChart`
 * adapts a Prometheus range response to it. Theme-aware; one uPlot instance,
 * re-fed on data change (no flicker).
 */

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export interface ChartSeries {
  label: string;
  /** [x, value] pairs — x is unix seconds (timeAxis) or an elapsed count. */
  points: [number, number][];
  color?: string;
  /** Which y-scale to bind to (default 'left'). */
  axis?: 'left' | 'right';
}

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** Align the (possibly ragged) per-series points onto one shared x-axis. */
function buildData(series: ChartSeries[]): uPlot.AlignedData {
  const xsSet = new Set<number>();
  for (const s of series) for (const [x] of s.points) xsSet.add(x);
  const xs = [...xsSet].sort((a, b) => a - b);
  const at = new Map(xs.map((x, i) => [x, i]));
  const cols = series.map((s) => {
    const col = new Array<number | null>(xs.length).fill(null);
    for (const [x, v] of s.points) {
      const i = at.get(x);
      if (i !== undefined) col[i] = v;
    }
    return col;
  });
  return [xs, ...cols] as unknown as uPlot.AlignedData;
}

export function UplotChart({
  series,
  height = 190,
  timeAxis = true,
}: {
  series: ChartSeries[];
  height?: number;
  timeAxis?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const hasRight = series.some((s) => s.axis === 'right');
  const shapeKey =
    series.map((s) => `${s.label}:${s.axis ?? 'left'}:${s.color ?? ''}`).join('|') +
    `@${height}@${timeAxis}`;

  // Build (or rebuild when the series set / axes / height change).
  useEffect(() => {
    if (!host.current) return;
    const ink = cssVar('--muted', '#6b7280');
    const grid = cssVar('--border', '#e4e8ef');
    const splineFactory = (uPlot.paths as { spline?: () => uPlot.Series.PathBuilder }).spline;
    const spline = splineFactory ? splineFactory() : undefined;

    const uSeries: uPlot.Series[] = [
      {},
      ...series.map((s, i) => ({
        label: s.label,
        stroke: s.color ?? COLORS[i % COLORS.length],
        width: 2,
        scale: s.axis === 'right' ? 'y2' : 'y',
        ...(spline ? { paths: spline } : {}),
        points: { show: false },
      })),
    ];
    const axes: uPlot.Axis[] = [
      { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
      {
        scale: 'y',
        stroke: ink,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: 44,
      },
    ];
    if (hasRight) {
      axes.push({
        scale: 'y2',
        side: 1,
        stroke: ink,
        grid: { show: false },
        ticks: { stroke: grid },
        size: 40,
      });
    }
    const opts: uPlot.Options = {
      width: host.current.clientWidth || 560,
      height,
      series: uSeries,
      legend: { show: true },
      cursor: { points: { size: 6 } },
      scales: { x: { time: timeAxis } },
      axes,
    };
    const u = new uPlot(opts, buildData(series), host.current);
    plot.current = u;
    const ro = new ResizeObserver(() => {
      if (host.current) u.setSize({ width: host.current.clientWidth, height });
    });
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // Data-only updates go through the effect below; `series` is read here at
    // build time but not a dependency.
  }, [shapeKey, hasRight]);

  // Re-feed data on each change without tearing down the plot.
  useEffect(() => {
    plot.current?.setData(buildData(series));
  }, [series]);

  return <div ref={host} className="promchart" />;
}

/** Adapts a Prometheus range response (all left-axis lines) to UplotChart. */
export function PromChart({ range, height = 200 }: { range: MetricsRange; height?: number }) {
  const series: ChartSeries[] = range.series.map((s) => ({ label: s.label, points: s.points }));
  return <UplotChart series={series} height={height} timeAxis />;
}
