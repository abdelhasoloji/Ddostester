import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { runFleetAssignment } from '../src/modules/fleet/agent.js';
import { assignmentHash, type AssignmentInput } from '../src/modules/fleet/contract.js';
import type { AttackAgent } from '../src/agents/types.js';
const policy = {
  agentId: 'one',
  allowedHosts: ['target.test'],
  allowedPorts: [80],
  caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
};
const assignment = () => {
  const now = Date.now();
  const input: AssignmentInput = {
    schema: 'ddostester.fleet.assignment/v1',
    campaignId: 'campaign',
    runId: 'run',
    agentId: 'one',
    attemptId: 'attempt',
    target: 'http://target.test/',
    maxRps: 5,
    concurrency: 2,
    durationSec: 30,
    notBefore: now,
    deadline: now + 30000,
    leaseUntil: now + 6000,
  };
  return { ...input, configHash: assignmentHash(input) };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('autonomous fleet agent with inert engines', () => {
  it('settles a natural run before the mission deadline despite bounded finalization delay', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    const item = assignment();
    const epoch = Date.now();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
    const run = vi.fn(
      (config) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ hardStopped: false }), config.durationSec * 1000 + 120),
        ),
    );
    const result = runFleetAssignment(
      item,
      policy,
      { renew: async () => ({ leaseUntil: Math.min(item.deadline, Date.now() + 6000) }) },
      undefined,
      { run } as unknown as AttackAgent,
    );
    await vi.advanceTimersByTimeAsync(28150);
    expect(await result).toMatchObject({ state: 'SUCCEEDED', reason: 'completed' });
    expect(Date.now()).toBeLessThan(item.deadline);
  });
  it('does not spawn generation for a pre-cancelled run', async () => {
    const run = vi.fn();
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await runFleetAssignment(
          assignment(),
          policy,
          { renew: async () => null },
          controller.signal,
          { run } as unknown as AttackAgent,
        )
      ).state,
    ).toBe('STOPPED');
    expect(run).not.toHaveBeenCalled();
  });
  it('stops on lost control and never retries the engine', async () => {
    vi.useFakeTimers();
    const run = vi.fn(
      (_c, _hosts, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
        ),
    );
    const result = runFleetAssignment(
      assignment(),
      policy,
      { renew: async () => null },
      undefined,
      { run } as unknown as AttackAgent,
    );
    await vi.advanceTimersByTimeAsync(2100);
    expect(await result).toMatchObject({ state: 'STOPPED', reason: 'control_lost' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects a renewed lease beyond the assignment deadline', async () => {
    vi.useFakeTimers();
    const item = assignment();
    const run = vi.fn(
      (_c, _h, signal: AbortSignal) =>
        new Promise((_r, reject) =>
          signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
        ),
    );
    const result = runFleetAssignment(
      item,
      policy,
      { renew: async () => ({ leaseUntil: item.deadline + 1 }) },
      undefined,
      { run } as unknown as AttackAgent,
    );
    await vi.advanceTimersByTimeAsync(2100);
    expect((await result).state).toBe('STOPPED');
  });
});
