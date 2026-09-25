import { describe, it, expect } from 'vitest';
import { probeLimitsFromEnv, PROBE_LIMITS } from '../src/config/limits.js';

describe('probeLimitsFromEnv', () => {
  it('returns the documented defaults when nothing is set', () => {
    expect(probeLimitsFromEnv({})).toEqual({ ...PROBE_LIMITS });
  });

  it('applies valid env overrides', () => {
    const l = probeLimitsFromEnv({
      PROBE_INTERVAL_MS: '1000',
      PROBE_WINDOW_KILL_AVAIL_PCT: '40',
      PROBE_LATENCY_KILL_MS: '2500',
    });
    expect(l.intervalMs).toBe(1000);
    expect(l.windowKillAvailPct).toBe(40);
    expect(l.latencyKillMs).toBe(2500);
    // untouched fields keep their defaults
    expect(l.timeoutMs).toBe(PROBE_LIMITS.timeoutMs);
  });

  it('falls back to the default for invalid or negative values', () => {
    const l = probeLimitsFromEnv({ PROBE_INTERVAL_MS: 'abc', PROBE_WINDOW_MS: '-5' });
    expect(l.intervalMs).toBe(PROBE_LIMITS.intervalMs);
    expect(l.windowMs).toBe(PROBE_LIMITS.windowMs);
  });
});

import { remoteProbeFromEnv } from '../src/config/limits.js';

describe('remoteProbeFromEnv', () => {
  it('returns null when neither URL nor token is set', () => {
    expect(remoteProbeFromEnv({})).toBeNull();
  });
  it('returns null when only one of URL / token is set', () => {
    expect(remoteProbeFromEnv({ PROBE_AGENT_URL: 'http://100.64.0.2:8099/probe' })).toBeNull();
    expect(remoteProbeFromEnv({ PROBE_AGENT_TOKEN: 'secret' })).toBeNull();
  });
  it('returns the config (trimmed) when both are set', () => {
    expect(
      remoteProbeFromEnv({
        PROBE_AGENT_URL: '  http://100.64.0.2:8099/probe  ',
        PROBE_AGENT_TOKEN: '  secret  ',
      }),
    ).toEqual({ agentUrl: 'http://100.64.0.2:8099/probe', token: 'secret' });
  });
});
