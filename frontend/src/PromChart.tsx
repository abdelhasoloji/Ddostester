import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { MetricsRange } from './api.js';

/**
 * App-native chart (option B) rendered with uPlot — the same engine Grafana
 * uses — so a graph in the app reads like a Grafana panel while the data comes
 * straight from the same Prometheus (via /api/metrics/range). Theme-aware; keeps
 * one uPlot instance and just re-feeds data on each poll (no flicker).
 */

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** Align the (possibly ragged) per-series points onto one shared x-axis. */
function buildData(range: MetricsRange): uPlot.AlignedData {
  const ts = new Set<number>();
  for (const s of range.series) for (const [t] of s.points) ts.add(t);
  const xs = [...ts].sort((a, b) => a - b);
  const at = new Map(xs.map((t, i) => [t, i]));
  const cols = range.series.map((s) => {
    const col = new Array<number | null>(xs.length).fill(null);
    for (const [t, v] of s.points) {
      const i = at.get(t);
      if (i !== undefined) col[i] = v;
    }
    return col;
  });
  return [xs, ...cols] as unknown as uPlot.AlignedData;
}

export function PromChart({ range, height = 190 }: { range: MetricsRange; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const labelsKey = range.series.map((s) => s.label).join('|') + `@${range.unit}`;

  // Build (or rebuild when the series set / unit changes).
  useEffect(() => {
    if (!host.current) return;
    const ink = cssVar('--muted', '#6b7280');
    const grid = cssVar('--border', '#e4e8ef');
    const spline = (uPlot.paths as { spline?: () => uPlot.Series.PathBuilder }).spline;
    const opts: uPlot.Options = {
      width: host.current.clientWidth || 560,
      height,
      series: [
        {},
        ...range.series.map((s, i) => ({
          label: s.label,
          stroke: COLORS[i % COLORS.length],
          width: 2,
          ...(spline ? { paths: spline() } : {}),
          points: { show: false },
        })),
      ],
      legend: { show: true },
      cursor: { points: { size: 6 } },
      scales: { x: { time: true } },
      axes: [
        { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 46 },
      ],
    };
    const u = new uPlot(opts, buildData(range), host.current);
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
    // Rebuild only when the shape (labels/unit/height) changes; per-poll data
    // updates go through the effect below. `range` is intentionally read here at
    // build time but not a dependency.
  }, [labelsKey, height]);

  // Re-feed data on each poll without tearing down the plot.
  useEffect(() => {
    plot.current?.setData(buildData(range));
  }, [range]);

  return <div ref={host} className="promchart" />;
}
