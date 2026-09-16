import type { WrsBreakdown } from './api.js';

export type WrsLevel = WrsBreakdown['level'];

/**
 * The single source of truth for the WRS letter bands: each level with its
 * inclusive lower bound. `gradeFromScore` (the Command Center pill) and the
 * guide legend's numeric ranges both derive from this, so the pill can never
 * disagree with the legend.
 */
export const WRS_BANDS: { level: WrsLevel; min: number }[] = [
  { level: 'A+', min: 90 },
  { level: 'A', min: 80 },
  { level: 'B', min: 70 },
  { level: 'C', min: 55 },
  { level: 'D', min: 40 },
  { level: 'F', min: 0 },
];

/** Letter grade for a 0–100 score (bands are ordered high→low). */
export function gradeFromScore(n: number): WrsLevel {
  return (WRS_BANDS.find((b) => n >= b.min) ?? WRS_BANDS[WRS_BANDS.length - 1]).level;
}

/** Display range for a band, e.g. "90–100" / "55–69" — derived from the bands. */
export function wrsRange(level: WrsLevel): string {
  const i = WRS_BANDS.findIndex((b) => b.level === level);
  const min = WRS_BANDS[i].min;
  const max = i === 0 ? 100 : WRS_BANDS[i - 1].min - 1;
  return `${min}–${max}`;
}

/** CSS class for a WRS pill/legend swatch (e.g. 'wrs-Ap', 'wrs-B'). */
export function wrsClass(level: WrsLevel): string {
  return 'wrs-' + level.replace('+', 'p');
}
