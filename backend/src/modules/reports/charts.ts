/**
 * charts.ts — self-contained inline-SVG chart generators for the HTML reports.
 *
 * No JavaScript, no external libraries, no web fonts: every chart is static SVG
 * markup so the report stays a single portable file that prints cleanly to PDF
 * and satisfies the strict CSP (markup only — no inline scripts). Design follows
 * the dataviz method: single-hue marks for one measure, direct value labels,
 * recessive grid, reserved status colours (with text, never colour alone), and
 * never a dual-axis chart (RPS and availability are two separate charts).
 */

import { htmlEscape as esc } from '../../util/text.js';

export const REPORT_COLORS = {
  brand: '#003484',
  brandFill: 'rgba(0, 52, 132, 0.14)',
  good: '#0f8a5f',
  goodFill: 'rgba(15, 138, 95, 0.14)',
  warn: '#b8860b',
  crit: '#c23b34',
  grid: '#e4e8ef',
  axis: '#9aa3b2',
  ink: '#1a1d21',
  muted: '#6b7280',
} as const;

const n = (v: number): number => (Number.isFinite(v) ? v : 0);
const r1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/** Grade colour for a 0–100 score (WRS/DRS). */
export function scoreColor(score: number): string {
  if (score >= 80) return REPORT_COLORS.good;
  if (score >= 55) return REPORT_COLORS.warn;
  return REPORT_COLORS.crit;
}

/**
 * Semicircular gauge for a 0–max score. Big number in the middle, coloured arc
 * by band. `sub` is a small caption under the value (e.g. the grade).
 */
export function gaugeSvg(
  value: number,
  opts: { max?: number; label?: string; sub?: string; color?: string } = {},
): string {
  const max = opts.max ?? 100;
  const v = Math.max(0, Math.min(max, n(value)));
  const color = opts.color ?? scoreColor((v / max) * 100);
  const W = 200;
  const H = 118;
  const cx = W / 2;
  const cy = 100;
  const R = 84;
  const pt = (frac: number): [number, number] => {
    const a = Math.PI * (1 - frac); // 0→π mapped left(180°)→right(0°)
    return [cx + R * Math.cos(a), cy - R * Math.sin(a)];
  };
  const arc = (fromFrac: number, toFrac: number, stroke: string, wdt: number): string => {
    const [x1, y1] = pt(fromFrac);
    const [x2, y2] = pt(toFrac);
    // The gauge spans a half-circle, so any sub-arc is ≤180° → large-arc-flag is
    // always 0 (never take the long way around). Sweep 1 = clockwise, left→right.
    return `<path d="M ${r1(x1)} ${r1(y1)} A ${R} ${R} 0 0 1 ${r1(x2)} ${r1(y2)}" fill="none" stroke="${stroke}" stroke-width="${wdt}" stroke-linecap="round"/>`;
  };
  const frac = v / max;
  return `<svg viewBox="0 0 ${W} ${H}" width="200" role="img" aria-label="${esc(opts.label ?? 'score')} ${r1(v)} of ${max}" class="chart-gauge">
  ${arc(0, 1, REPORT_COLORS.grid, 14)}
  ${frac > 0 ? arc(0, frac, color, 14) : ''}
  <text x="${cx}" y="86" text-anchor="middle" font-size="40" font-weight="800" fill="${color}">${Math.round(v)}</text>
  ${opts.sub ? `<text x="${cx}" y="108" text-anchor="middle" font-size="13" font-weight="600" fill="${REPORT_COLORS.muted}">${esc(opts.sub)}</text>` : ''}
</svg>`;
}

/**
 * A single-measure timeline (area + line) over t seconds. Used for the RPS trace
 * and, separately (never on the same axes), the availability trace.
 */
export function timelineSvg(
  points: { t: number; y: number }[],
  opts: {
    yMax?: number;
    color?: string;
    fill?: string;
    yUnit?: string;
    title?: string;
    height?: number;
    xMax?: number;
    stepped?: boolean;
  } = {},
): string {
  const W = 640;
  const H = opts.height ?? 200;
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const color = opts.color ?? REPORT_COLORS.brand;
  const fill = opts.fill ?? REPORT_COLORS.brandFill;

  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.y));
  if (pts.length < 2) {
    return `<div class="chart-empty">No time-series captured for this run.</div>`;
  }
  const tMax = Math.max(opts.xMax ?? 1, ...pts.map((p) => p.t));
  const yMax = opts.yMax ?? Math.max(1, Math.ceil(Math.max(...pts.map((p) => p.y)) * 1.1));
  const X = (t: number): number => padL + (t / tMax) * plotW;
  const Y = (y: number): number => padT + plotH - (Math.max(0, Math.min(yMax, y)) / yMax) * plotH;

  const line = pts
    .map((p, i) =>
      i && opts.stepped
        ? `H ${r1(X(p.t))} V ${r1(Y(p.y))}`
        : `${i ? 'L' : 'M'} ${r1(X(p.t))} ${r1(Y(p.y))}`,
    )
    .join(' ');
  const area = `${line} L ${r1(X(pts[pts.length - 1].t))} ${r1(padT + plotH)} L ${r1(X(pts[0].t))} ${r1(padT + plotH)} Z`;

  // 4 horizontal gridlines + y labels.
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padT + plotH - f * plotH;
      const val = Math.round(yMax * f);
      return `<line x1="${padL}" y1="${r1(y)}" x2="${W - padR}" y2="${r1(y)}" stroke="${REPORT_COLORS.grid}" stroke-width="1"/><text x="${padL - 6}" y="${r1(y + 4)}" text-anchor="end" font-size="11" fill="${REPORT_COLORS.muted}">${val}</text>`;
    })
    .join('');
  // x ticks at 0, mid, end.
  const xticks = [0, 0.5, 1]
    .map((f) => {
      const t = Math.round(tMax * f);
      return `<text x="${r1(X(t))}" y="${H - 8}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}" font-size="11" fill="${REPORT_COLORS.muted}">${t}s</text>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opts.title ?? 'timeline')}" class="chart-timeline" preserveAspectRatio="xMidYMid meet">
  ${grid}
  <path d="${area}" fill="${fill}" stroke="none"/>
  <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  ${xticks}
  ${opts.yUnit ? `<text x="${padL - 6}" y="${padT - 2}" text-anchor="end" font-size="10" fill="${REPORT_COLORS.muted}">${esc(opts.yUnit)}</text>` : ''}
</svg>`;
}

/**
 * Horizontal bars for one measure, single hue, each row direct-labelled. Used
 * for the WRS components (0–1) and the latency percentiles (ms).
 */
export function hbarsSvg(
  items: { label: string; value: number; display?: string }[],
  opts: { max: number; color?: string; barColor?: (v: number) => string } = { max: 1 },
): string {
  const rows = items.filter(Boolean);
  if (rows.length === 0) return '';
  const W = 640;
  const rowH = 30;
  const gap = 8;
  const labelW = 150;
  const valW = 62;
  const trackW = W - labelW - valW;
  const H = rows.length * (rowH + gap);
  const max = opts.max || Math.max(1, ...rows.map((r) => r.value));
  const svgRows = rows
    .map((row, i) => {
      const y = i * (rowH + gap);
      const w = Math.max(0, Math.min(1, n(row.value) / max)) * trackW;
      const c = opts.barColor ? opts.barColor(row.value) : (opts.color ?? REPORT_COLORS.brand);
      return `<text x="0" y="${y + rowH / 2 + 4}" font-size="13" fill="${REPORT_COLORS.ink}">${esc(row.label)}</text>
  <rect x="${labelW}" y="${y + 4}" width="${trackW}" height="${rowH - 8}" rx="4" fill="${REPORT_COLORS.grid}"/>
  <rect x="${labelW}" y="${y + 4}" width="${r1(w)}" height="${rowH - 8}" rx="4" fill="${c}"/>
  <text x="${W}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="13" font-weight="600" fill="${REPORT_COLORS.ink}">${esc(row.display ?? r1(row.value))}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" class="chart-hbars" preserveAspectRatio="xMidYMid meet">${svgRows}</svg>`;
}

/** A compact trend sparkline (e.g. WRS across a period). */
export function sparklineSvg(
  values: number[],
  opts: { color?: string; width?: number; height?: number; yMax?: number } = {},
): string {
  const vals = values.filter((v) => Number.isFinite(v));
  const W = opts.width ?? 160;
  const H = opts.height ?? 36;
  if (vals.length < 2) return `<span class="muted">—</span>`;
  const yMax = opts.yMax ?? (Math.max(...vals) * 1.05 || 1);
  const yMin = Math.min(...vals) * 0.95;
  const range = yMax - yMin || 1;
  const X = (i: number): number => (i / (vals.length - 1)) * (W - 4) + 2;
  const Y = (v: number): number => H - 2 - ((v - yMin) / range) * (H - 4);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'} ${r1(X(i))} ${r1(Y(v))}`).join(' ');
  const last = vals[vals.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" class="chart-spark" role="img" aria-label="trend"><path d="${line}" fill="none" stroke="${opts.color ?? REPORT_COLORS.brand}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${r1(X(vals.length - 1))}" cy="${r1(Y(last))}" r="3" fill="${opts.color ?? REPORT_COLORS.brand}"/></svg>`;
}
