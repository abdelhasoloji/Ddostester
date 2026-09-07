import { describe, it, expect } from 'vitest';
import {
  gaugeSvg,
  timelineSvg,
  hbarsSvg,
  sparklineSvg,
  scoreColor,
  REPORT_COLORS,
} from '../src/modules/reports/charts.js';

describe('report charts (pure SVG)', () => {
  it('scoreColor bands A/B/F by threshold', () => {
    expect(scoreColor(90)).toBe(REPORT_COLORS.good);
    expect(scoreColor(60)).toBe(REPORT_COLORS.warn);
    expect(scoreColor(40)).toBe(REPORT_COLORS.crit);
  });

  it('gauge renders an svg with the rounded value and no NaN', () => {
    const svg = gaugeSvg(88, { sub: 'A' });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('>88<');
    expect(svg).toContain('A');
    expect(svg).not.toMatch(/NaN/);
  });

  it('gauge clamps out-of-range and stays finite', () => {
    expect(gaugeSvg(9999)).not.toMatch(/NaN/);
    expect(gaugeSvg(Number.NaN)).not.toMatch(/NaN/);
    expect(gaugeSvg(-5)).toContain('>0<');
  });

  it('timeline draws an area + line path from points, with second-axis ticks', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ t: i, y: i * 10 }));
    const svg = timelineSvg(pts, { yUnit: 'rps' });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('rps');
    expect(svg).toContain('9s'); // last x tick
    expect(svg).not.toMatch(/NaN/);
  });

  it('timeline degrades to a note when there is no series', () => {
    expect(timelineSvg([])).toContain('No time-series');
    expect(timelineSvg([{ t: 0, y: 1 }])).toContain('No time-series');
  });

  it('hbars renders one bar per item with its display label', () => {
    const svg = hbarsSvg(
      [
        { label: 'Detection', value: 0.8, display: '0.80' },
        { label: 'Availability', value: 1, display: '1.00' },
      ],
      { max: 1 },
    );
    expect(svg).toContain('Detection');
    expect(svg).toContain('0.80');
    expect(svg).toContain('Availability');
    expect(svg).not.toMatch(/NaN/);
  });

  it('sparkline needs ≥2 points, else a dash', () => {
    expect(sparklineSvg([1])).toContain('—');
    expect(sparklineSvg([1, 2, 3])).toMatch(/^<svg/);
  });
});
