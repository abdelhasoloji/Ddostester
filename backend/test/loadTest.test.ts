import { describe, it, expect } from 'vitest';
import { validateConfig, InvalidConfigError, TargetNotAllowedError } from '../src/engine/loadTest.js';
import type { LoadTestConfig } from '../src/engine/types.js';

const base: LoadTestConfig = {
  url: 'http://localhost:3000/health',
  concurrency: 5,
  durationSec: 3,
  maxRps: 50,
  authorized: true,
};

describe('validateConfig', () => {
  it('accepte une cible autorisée', () => {
    expect(() => validateConfig(base, ['localhost'])).not.toThrow();
  });

  it('refuse un test non autorisé', () => {
    expect(() => validateConfig({ ...base, authorized: false }, ['localhost'])).toThrow(
      InvalidConfigError,
    );
  });

  it('refuse une cible hors liste blanche', () => {
    expect(() => validateConfig({ ...base, url: 'http://example.com/' }, ['localhost'])).toThrow(
      TargetNotAllowedError,
    );
  });

  it('exige un plafond maxRps positif', () => {
    expect(() => validateConfig({ ...base, maxRps: 0 }, ['localhost'])).toThrow(InvalidConfigError);
  });

  it('borne la concurrence', () => {
    expect(() => validateConfig({ ...base, concurrency: 5000 }, ['localhost'])).toThrow(
      InvalidConfigError,
    );
  });
});
