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

export interface Threshold {
  value: number;
  label?: string;
  color?: string;
}

export function UplotChart({
  series,
  height = 190,
  timeAxis = true,
  yRange,
  yFromZero = false,
  thresholds,
  onPointClick,
}: {
  series: ChartSeries[];
  height?: number;
  timeAxis?: boolean;
  /** Fixed left y-scale (e.g. [0, 100] for a score); omit to auto-range. */
  yRange?: [number, number];
  /**
   * Auto-range the left y-scale but anchor it at 0 (so a rate line — e.g.
   * requests/s of any magnitude — is always fully in frame from 0 to its max,
   * never clipped by uPlot's default range picking a non-zero floor/ceiling).
   */
  yFromZero?: boolean;
  /** Dashed horizontal reference lines (e.g. an alert threshold). */
  thresholds?: Threshold[];
  /** Called with the nearest data index when the plot is clicked. */
  onPointClick?: (dataIdx: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // The native uPlot legend only fills in on hover (blank "--" at rest), so we
  // render our own: it shows the latest value idle, the cursor value on hover.
  const updateLegendRef = useRef<((u: uPlot) => void) | null>(null);
  const hasRight = series.some((s) => s.axis === 'right');
  // Keep the click handler current without rebuilding the plot.
  const clickRef = useRef(onPointClick);
  clickRef.current = onPointClick;
  const shapeKey =
    series.map((s) => `${s.label}:${s.axis ?? 'left'}:${s.color ?? ''}`).join('|') +
    `@${height}@${timeAxis}@${yRange?.join('-') ?? ''}@${yFromZero ? 'z' : ''}@${(thresholds ?? [])
      .map((t) => t.value)
      .join(',')}@${onPointClick ? 'clk' : ''}`;

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
    const warn = cssVar('--warning', '#b8860b');
    const opts: uPlot.Options = {
      width: host.current.clientWidth || 560,
      height,
      series: uSeries,
      legend: { show: false },
      cursor: { points: { size: 6 } },
      scales: {
        // Leave the x-scale in uPlot's DEFAULT auto mode: it re-ranges to the
        // data's [min,max] on every setData, so a live numeric (elapsed-seconds)
        // axis tracks the newest sample on its own. The earlier bug was a manual
        // `setScale('x', …)` in the data-update path: calling it once switches the
        // scale OUT of auto mode, pinning it at that moment's extent (e.g. [1,2]
        // from the first two samples) so it never advanced. No manual setScale and
        // no range function here — auto mode is what keeps it moving.
        x: { time: timeAxis },
        y: yRange
          ? { range: () => yRange }
          : yFromZero
            ? {
                // Anchor at 0 and span to the max of ALL left-axis data — not
                // uPlot's per-x-window max. When the x-view is narrow (or was
                // briefly pinned), the window max can be ~0 and the axis collapses
                // to [0,1], hiding a 514 rps line entirely. Scanning the full data
                // keeps the rate line in frame regardless of the x-scale.
                range: (u: uPlot): [number, number] => {
                  let mx = 0;
                  for (let i = 1; i < u.series.length; i++) {
                    if ((u.series[i].scale ?? 'y') !== 'y') continue;
                    const col = u.data[i] as (number | null)[] | undefined;
                    if (col) for (const v of col) if (v != null && v > mx) mx = v;
                  }
                  return [0, mx > 0 ? mx : 1];
                },
              }
            : {},
        // Declare the right scale explicitly (when used) so it is fully
        // independent of the left one — a percentage series on 'y2' must never
        // constrain a rate series on 'y' (which would clip requests/s > 100).
        ...(hasRight ? { y2: {} } : {}),
      },
      axes,
      hooks: {
        // Keep the always-on legend in sync with the cursor (idle → latest).
        setCursor: [(u: uPlot) => updateLegendRef.current?.(u)],
        draw: thresholds?.length
          ? [
              (u: uPlot) => {
                const ctx = u.ctx;
                for (const t of thresholds) {
                  const yPos = Math.round(u.valToPos(t.value, 'y', true));
                  ctx.save();
                  ctx.strokeStyle = t.color ?? warn;
                  ctx.setLineDash([4, 4]);
                  ctx.lineWidth = 1;
                  ctx.beginPath();
                  ctx.moveTo(u.bbox.left, yPos);
                  ctx.lineTo(u.bbox.left + u.bbox.width, yPos);
                  ctx.stroke();
                  if (t.label) {
                    ctx.setLineDash([]);
                    ctx.fillStyle = t.color ?? warn;
                    ctx.font = '10px system-ui, sans-serif';
                    ctx.fillText(t.label, u.bbox.left + 4, yPos - 3);
                  }
                  ctx.restore();
                }
              },
            ]
          : undefined,
      },
    };
    const u = new uPlot(opts, buildData(series), host.current);
    plot.current = u;

    // Build our always-on legend and its live-update function.
    const valEls: HTMLElement[] = [];
    let xEl: HTMLElement | null = null;
    const legendHost = legend.current;
    if (legendHost) {
      legendHost.innerHTML = '';
      const mkItem = (cls: string) => {
        const item = document.createElement('span');
        item.className = `ucl-item${cls}`;
        return item;
      };
      const xItem = mkItem(' ucl-x');
      const xk = document.createElement('span');
      xk.className = 'ucl-k';
      xk.textContent = timeAxis ? 'Time' : 'Value';
      xEl = document.createElement('span');
      xEl.className = 'ucl-v';
      xEl.textContent = '--';
      xItem.append(xk, xEl);
      legendHost.appendChild(xItem);
      series.forEach((s, i) => {
        const item = mkItem('');
        const sw = document.createElement('span');
        sw.className = 'ucl-swatch';
        sw.style.background = s.color ?? COLORS[i % COLORS.length];
        const k = document.createElement('span');
        k.className = 'ucl-k';
        k.textContent = s.label;
        const v = document.createElement('span');
        v.className = 'ucl-v';
        v.textContent = '--';
        item.append(sw, k, v);
        legendHost.appendChild(item);
        valEls.push(v);
      });
    }
    const fmtV = (v: number | null | undefined): string =>
      v == null || Number.isNaN(v)
        ? '--'
        : Math.abs(v) >= 100
          ? Math.round(v).toString()
          : Math.abs(v) >= 1
            ? v.toFixed(1)
            : v.toFixed(2);
    const fmtX = (x: number | null | undefined): string =>
      x == null ? '--' : timeAxis ? new Date(x * 1000).toLocaleTimeString() : `${x}s`;
    updateLegendRef.current = (uu: uPlot) => {
      const xs = uu.data[0] as number[];
      const idx = uu.cursor.idx ?? (xs.length ? xs.length - 1 : null);
      if (xEl) xEl.textContent = idx == null ? '--' : fmtX(xs[idx]);
      valEls.forEach((el, i) => {
        const col = uu.data[i + 1] as (number | null)[] | undefined;
        el.textContent = idx == null || !col ? '--' : fmtV(col[idx]);
      });
    };
    updateLegendRef.current(u);

    const onClick = () => {
      const idx = u.cursor.idx;
      if (idx != null && clickRef.current) clickRef.current(idx);
    };
    if (onPointClick) {
      u.over.style.cursor = 'pointer';
      u.over.addEventListener('click', onClick);
    }
    const ro = new ResizeObserver(() => {
      if (host.current) u.setSize({ width: host.current.clientWidth, height });
    });
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      if (onPointClick) u.over.removeEventListener('click', onClick);
      u.destroy();
      plot.current = null;
      updateLegendRef.current = null;
    };
    // Data-only updates go through the effect below; `series` is read here at
    // build time but not a dependency.
  }, [shapeKey, hasRight]);

  // Re-feed data on each change without tearing down the plot.
  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    // setData re-ranges every auto-mode scale (including the numeric x-axis) to
    // the new data extent, so the live axis tracks the latest sample on its own.
    // Never call setScale('x', …) here — that pins the scale and stops it moving.
    u.setData(buildData(series));
    updateLegendRef.current?.(u); // keep the idle legend on the latest sample
  }, [series]);

  return (
    <div className="promchart-wrap">
      <div ref={host} className="promchart" />
      <div ref={legend} className="uchart-legend" />
    </div>
  );
}

/**
 * The y-scale a Prometheus panel should use, from its series unit — so panels are
 * never mis-scaled:
 *  - percent → fixed [0,100] (an availability/absorption line can't run to 200%);
 *  - a rate/latency (reqps/ms) → anchored at 0 and fitted to its max (so a 349 rps
 *    line isn't clipped by uPlot's default range picking ~[0,100]);
 *  - anything else → uPlot auto-range.
 * Pure, so it's unit-tested without a canvas.
 */
export function yConfigForUnit(unit: string): { yRange?: [number, number]; yFromZero: boolean } {
  if (unit === 'percent') return { yRange: [0, 100], yFromZero: false };
  if (unit === 'reqps' || unit === 'ms') return { yFromZero: true };
  return { yFromZero: false };
}

/** Adapts a Prometheus range response (all left-axis lines) to UplotChart. */
export function PromChart({ range, height = 200 }: { range: MetricsRange; height?: number }) {
  const series: ChartSeries[] = range.series.map((s) => ({ label: s.label, points: s.points }));
  const { yRange, yFromZero } = yConfigForUnit(range.unit);
  return (
    <UplotChart series={series} height={height} timeAxis yRange={yRange} yFromZero={yFromZero} />
  );
}
