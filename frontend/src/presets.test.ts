import { describe, it, expect } from 'vitest';
import { PRESETS, estimatedRequests, formatCount } from './presets.js';

describe('estimatedRequests', () => {
  it('constant = rps × duration', () => {
    expect(estimatedRequests(100, 60, 'constant')).toBe(6000);
  });
  it('ramp uses the average of 25/50/100%', () => {
    // (0.25 + 0.5 + 1)/3 = 0.5833 → 100 × 60 × 0.5833 ≈ 3500
    expect(estimatedRequests(100, 60, 'ramp')).toBe(3500);
  });
  it('wave uses the average of 100/20/100%', () => {
    // (1 + 0.2 + 1)/3 = 0.7333 → 100 × 60 × 0.7333 ≈ 4400
    expect(estimatedRequests(100, 60, 'wave')).toBe(4400);
  });
});

describe('formatCount', () => {
  it('formats thousands and millions', () => {
    expect(formatCount(500)).toBe('500');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(12000)).toBe('12k');
    expect(formatCount(2_000_000)).toBe('2.0M');
  });
});

describe('PRESETS', () => {
  it('are all within the hard caps', () => {
    for (const p of PRESETS) {
      expect(p.maxRps).toBeGreaterThan(0);
      expect(p.maxRps).toBeLessThanOrEqual(2000);
      expect(p.concurrency).toBeLessThanOrEqual(500);
      expect(p.maxDurationSec).toBeLessThanOrEqual(900);
    }
  });
});
