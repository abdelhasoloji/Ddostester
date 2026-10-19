import { describe, expect, it } from 'vitest';
import {
  controlOrigin,
  parseControlResponse,
  readAgentPolicy,
} from '../src/modules/fleet/agent-client.js';

const policy = JSON.stringify({
  allowedHosts: ['lab-target'],
  allowedPorts: [8080],
  caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
});

describe('fleet agent client — trusted inputs (M2.2)', () => {
  it('accepts a bounded policy file', () => {
    expect(readAgentPolicy(policy)).toEqual({
      allowedHosts: ['lab-target'],
      allowedPorts: [8080],
      caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
    });
  });

  it('refuses caps above the frozen ceiling', () => {
    expect(() =>
      readAgentPolicy(
        JSON.stringify({
          allowedHosts: ['lab-target'],
          allowedPorts: [8080],
          caps: { maxRps: 2001, maxConcurrency: 6, maxDurationSec: 60 },
        }),
      ),
    ).toThrow('Invalid trusted fleet policy');
  });

  it('refuses malformed hosts and ports', () => {
    for (const change of [
      { allowedHosts: [8080] },
      { allowedPorts: ['8080'] },
      { allowedPorts: [0] },
      { allowedPorts: [70_000] },
      { allowedPorts: [8080.5] },
    ]) {
      expect(() =>
        readAgentPolicy(
          JSON.stringify({
            allowedHosts: ['lab-target'],
            allowedPorts: [8080],
            caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
            ...change,
          }),
        ),
      ).toThrow('Invalid trusted fleet policy');
    }
  });

  it('requires an HTTPS control origin without embedded credentials', () => {
    expect(controlOrigin('https://lab-fleet:8443').hostname).toBe('lab-fleet');
    expect(() => controlOrigin('http://lab-fleet:8443')).toThrow('Fleet control requires HTTPS');
    expect(() => controlOrigin('https://user:pass@lab-fleet:8443')).toThrow(
      'Fleet control requires HTTPS',
    );
  });

  it('accepts only a JSON object as a control response', () => {
    expect(parseControlResponse({ assignment: null })).toEqual({ assignment: null });
    for (const value of [null, [], 'text', 4]) {
      expect(() => parseControlResponse(value)).toThrow('Invalid fleet response');
    }
  });
});
