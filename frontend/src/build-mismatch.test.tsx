import { describe, it, expect } from 'vitest';
import { isBuildMismatch } from './pages.js';

describe('isBuildMismatch', () => {
  it('flags a differing real commit', () => {
    expect(isBuildMismatch({ commit: 'aaaaaaa' }, 'bbbbbbb')).toBe(true);
  });
  it('is quiet when commits match', () => {
    expect(isBuildMismatch({ commit: 'aaaaaaa' }, 'aaaaaaa')).toBe(false);
  });
  it('is quiet when either side is unknown (dev) or missing', () => {
    expect(isBuildMismatch({ commit: 'dev' }, 'aaaaaaa')).toBe(false);
    expect(isBuildMismatch({ commit: 'aaaaaaa' }, 'dev')).toBe(false);
    expect(isBuildMismatch(null, 'aaaaaaa')).toBe(false);
    expect(isBuildMismatch({ commit: '' }, 'aaaaaaa')).toBe(false);
  });
});
