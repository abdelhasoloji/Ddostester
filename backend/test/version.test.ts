import { describe, it, expect } from 'vitest';
import { getBuildInfo, _resetBuildInfoCache } from '../src/version.js';

describe('getBuildInfo', () => {
  it('returns a well-formed stamp with safe defaults from source (no build-info.json)', () => {
    _resetBuildInfoCache();
    const bi = getBuildInfo();
    // semver comes from package.json; build/commit fall back when the generated
    // dist/build-info.json is absent (a from-source run).
    expect(bi.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof bi.build).toBe('string');
    expect(typeof bi.commit).toBe('string');
  });

  it('memoises the result', () => {
    _resetBuildInfoCache();
    expect(getBuildInfo()).toBe(getBuildInfo());
  });
});
