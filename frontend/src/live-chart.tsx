import { useEffect, useRef, useState } from 'react';
import type { ChartSeries } from './PromChart.js';

/**
 * A pure-SVG line chart for the LIVE run panels. It exists because the imperative
 * uPlot wrapper (`UplotChart`) kept de-syncing from React's streaming data — its
 * auto-scale would collapse or lag, so a run 11 s in rendered as an x-axis of
 * [0,2] with a y-axis maxing ~15 while the tiles read 92 rps. This component has
 * NO imperative lifecycle: every render draws the current data against explicit,
 * caller-supplied domains, so what you see is always exactly the latest samples.
 *
 * - x-domain is passed in (shared across sibling panels → they stay aligned);
 * - left y is a fixed `yRange` (e.g. [0,100] for a %) or, with `yFromZero`,
 *   0→(rounded max of the data) so a rate line is always fully in frame;
 * - an optional right axis (series with `axis:'right'`) auto-ranges from 0.
 * Pure functions (`niceTicks`, `pathFor`) are exported for unit tests.
 */

/** Round, human-friendly tick values from 0 up to at least `max`. Pure. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) {
    out.push(Math.round((v + Number.EPSILON) * 1000) / 1000);
  }
  // Guarantee the domain top covers the data max (extend by one step if needed).
  if (out[out.length - 1] < max) out.push(Math.round((out[out.length - 1] + step) * 1000) / 1000);
  return out;
}

/** Build an SVG path from [x,y] points, breaking the line across null gaps so a
 *  missing sample never draws a stroke back to zero. `sx`/`sy` are the scales. */
export function pathFor(
  points: [number, number | null][],
  sx: (x: number) => number,
  sy: (y: number) => number,
  stepped = false,
): string {
  let d = '';
  let pen = false; // whether the last command left the pen down
  for (const [x, y] of points) {
    if (y == null || !Number.isFinite(y)) {
      pen = false;
      continue;
    }
    d +=
      pen && stepped
        ? `H${sx(x).toFixed(1)} V${sy(y).toFixed(1)} `
        : `${pen ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(y).toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

const fmt = (v: number): string =>
  Math.abs(v) >= 100 ? Math.round(v).toString() : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2);

const lastOf = (pts: [number, number][]): number | null =>
  pts.length ? pts[pts.length - 1][1] : null;

export function LiveLineChart({
  series,
  height = 140,
  xDomain,
  yRange,
  stepped = false,
  pointsOnly = false,
}: {
  series: ChartSeries[];
  pointsOnly?: boolean;
  stepped?: boolean;
  height?: number;
  /** Shared numeric x-domain [min, max] — never derived from the data, so
   *  sibling panels stay in lockstep and the axis reflects true elapsed time. */
  xDomain: [number, number];
  /** Fixed left y-scale (e.g. [0, 100]); omit to anchor at 0 and fit the data
   *  max (so a rate/latency line is always fully in frame). */
  yRange?: [number, number];
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 560));
    ro.observe(el);
    setW(el.clientWidth || 560);
    return () => ro.disconnect();
  }, []);

  const left = series.filter((s) => (s.axis ?? 'left') === 'left');
  const right = series.filter((s) => s.axis === 'right');
  const padL = 40;
  const padR = right.length ? 38 : 14;
  const padT = 10;
  const padB = 22;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, height - padT - padB);

  const [x0, x1] = xDomain;
  const xSpan = x1 - x0 || 1;
  const sx = (x: number) => padL + ((x - x0) / xSpan) * plotW;

  const maxOf = (ss: ChartSeries[]) => {
    let m = 0;
    for (const s of ss) for (const [, v] of s.points) if (v != null && v > m) m = v;
    return m;
  };
  // Left scale: fixed range, or 0→rounded-max from the tick ladder.
  const leftTicks = yRange ? niceTicks(yRange[1], 4) : niceTicks(maxOf(left), 4);
  const leftTop = yRange ? yRange[1] : leftTicks[leftTicks.length - 1];
  const leftBot = yRange ? yRange[0] : 0;
  const leftSpan = leftTop - leftBot || 1;
  const syL = (v: number) => padT + (1 - (v - leftBot) / leftSpan) * plotH;

  const rightTicks = niceTicks(maxOf(right), 3);
  const rightTop = rightTicks[rightTicks.length - 1] || 1;
  const syR = (v: number) => padT + (1 - v / rightTop) * plotH;

  const xTicks = niceTicks(x1, 5).filter((t) => t <= x1 + 1e-6);

  return (
    <div ref={wrap} className="lc-wrap">
      <svg
        className="lc-svg"
        width={w}
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* horizontal grid + left y labels */}
        {leftTicks.map((t) => {
          const y = syL(t);
          return (
            <g key={`gy${t}`}>
              <line className="lc-grid" x1={padL} x2={w - padR} y1={y} y2={y} />
              <text
                className="lc-tick"
                x={padL - 6}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {fmt(t)}
              </text>
            </g>
          );
        })}
        {/* right y labels (when a right axis is used) */}
        {right.length > 0 &&
          rightTicks.map((t) => (
            <text
              key={`ry${t}`}
              className="lc-tick"
              x={w - padR + 6}
              y={syR(t)}
              textAnchor="start"
              dominantBaseline="middle"
            >
              {fmt(t)}
            </text>
          ))}
        {/* x labels */}
        {xTicks.map((t) => (
          <text key={`gx${t}`} className="lc-tick" x={sx(t)} y={height - 6} textAnchor="middle">
            {fmt(t)}
          </text>
        ))}
        {/* baseline (y = leftBot) */}
        <line className="lc-axis" x1={padL} x2={w - padR} y1={syL(leftBot)} y2={syL(leftBot)} />

        {/* area fill under the primary left series */}
        {!pointsOnly && left[0] && !left[0].breakBefore?.length && left[0].points.length > 1 && (
          <path
            className="lc-area"
            d={
              `M${sx(left[0].points[0][0]).toFixed(1)} ${syL(leftBot).toFixed(1)} ` +
              left[0].points
                .filter(([, v]) => v != null)
                .map(([x, v]) => `L${sx(x).toFixed(1)} ${syL(v as number).toFixed(1)}`)
                .join(' ') +
              ` L${sx(left[0].points[left[0].points.length - 1][0]).toFixed(1)} ${syL(leftBot).toFixed(1)} Z`
            }
            fill={left[0].color ?? '#3b82f6'}
          />
        )}

        {/* series lines + endpoint dots */}
        {[...left.map((s) => ({ s, sy: syL })), ...right.map((s) => ({ s, sy: syR }))].map(
          ({ s, sy }) => {
            return (
              <g key={`${s.label}:${s.axis ?? 'left'}`}>
                {!pointsOnly && (
                  <path
                    className="lc-line"
                    d={pathFor(
                      s.points.flatMap(([x, y]): [number, number | null][] =>
                        s.breakBefore?.includes(x)
                          ? [
                              [x, null],
                              [x, y],
                            ]
                          : [[x, y]],
                      ),
                      sx,
                      sy,
                      stepped,
                    )}
                    stroke={s.color ?? '#3b82f6'}
                    fill="none"
                  />
                )}
                {pointsOnly &&
                  s.points.map(([x, y]) => (
                    <circle
                      key={x}
                      className="lc-dot"
                      cx={sx(x)}
                      cy={sy(y)}
                      r={3}
                      fill={s.color ?? '#3b82f6'}
                    />
                  ))}
                {!pointsOnly &&
                  s.points
                    .filter(
                      (_, i) =>
                        i === s.points.length - 1 || s.breakBefore?.includes(s.points[i + 1][0]),
                    )
                    .map(([x, y]) => (
                      <circle
                        key={x}
                        className="lc-dot"
                        cx={sx(x)}
                        cy={sy(y)}
                        r={3}
                        fill={s.color ?? '#3b82f6'}
                      />
                    ))}
              </g>
            );
          },
        )}
      </svg>
      <div className="lc-legend">
        {series.map((s) => (
          <span key={`${s.label}:${s.axis ?? 'left'}`} className="lc-leg-item">
            <span className="lc-swatch" style={{ background: s.color ?? '#3b82f6' }} />
            {s.label}
            <b>{lastOf(s.points) != null ? fmt(lastOf(s.points) as number) : '—'}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
