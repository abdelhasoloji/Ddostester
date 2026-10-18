import { describe, expect, it } from 'vitest';
import { createFleetExecutor, FLEET_NAMESPACE } from '../src/modules/fleet/executor.js';
import { FleetHttpAgent } from '../src/agents/fleet.js';

const DIGEST = `docker.io/library/ddostester-lab-control@sha256:${'a'.repeat(64)}`;

describe('FleetExecutor port (M2.1)', () => {
  it('builds the local executor from a digest-pinned image', () => {
    const executor = createFleetExecutor({ FLEET_AGENT_IMAGE: DIGEST } as NodeJS.ProcessEnv);
    for (const method of ['create', 'remove', 'evidence', 'close'] as const)
      expect(typeof executor[method]).toBe('function');
  });

  it('refuses a mutable image tag', () => {
    expect(() =>
      createFleetExecutor({ FLEET_AGENT_IMAGE: 'ddostester-lab-control:latest' } as NodeJS.ProcessEnv),
    ).toThrow(/immutable local agent image/);
  });

  it('requires an image', () => {
    expect(() => createFleetExecutor({} as NodeJS.ProcessEnv)).toThrow('FLEET_AGENT_IMAGE required');
  });

  it('pins the dedicated lab namespace', () => {
    expect(FLEET_NAMESPACE).toBe('ddostester-lab');
  });

  it('accepts an injected executor without bypassing availability gating', async () => {
    const fake = {
      create: async () => 'fleet-run-one',
      remove: async () => undefined,
      evidence: async () => ({ available: true }),
      close: async () => undefined,
    };
    const agent = new FleetHttpAgent(fake);
    // An injected executor is a wiring seam, not a licence: the fleet still only
    // reports itself available when the process is configured for it.
    expect(await agent.available()).toBe(false);
  });
});
