import { describe, expect, it } from 'vitest';
import type { FleetAssignment } from '../src/modules/fleet/contract.js';
import { runWorkerLoop } from '../src/modules/fleet/worker.js';

const assignment = (over: Partial<FleetAssignment> = {}): FleetAssignment => ({
  schema: 'ddostester.fleet.assignment/v1',
  campaignId: 'campaign',
  runId: 'run',
  agentId: 'one',
  attemptId: 'attempt',
  target: 'http://target.test:8080/',
  maxRps: 1,
  concurrency: 1,
  durationSec: 10,
  notBefore: 0,
  deadline: 1,
  leaseUntil: 1,
  configHash: 'hash',
  ...over,
});

describe('resident worker loop (M2.2)', () => {
  it('executes the shard it is given and reports the outcome', async () => {
    const stop = new AbortController();
    const executed: string[] = [];
    const reported: string[] = [];
    let served = false;
    const run = await runWorkerLoop(
      {
        poll: async () => {
          if (served) return null;
          served = true;
          return assignment();
        },
        execute: async (item) => {
          executed.push(item.agentId);
          stop.abort();
          return { state: 'SUCCEEDED', reason: 'completed' };
        },
        report: async (item) => {
          reported.push(item.runId);
          return true;
        },
      },
      { pollMs: 1, signal: stop.signal },
    );
    expect(executed).toEqual(['one']);
    expect(reported).toEqual(['run']);
    expect(run).toMatchObject({ executed: 1, reported: 1, stoppedBy: 'signal' });
  });

  it('idles without executing when there is no work', async () => {
    const stop = new AbortController();
    const pending = runWorkerLoop(
      {
        poll: async () => null,
        execute: async () => {
          throw new Error('must not execute');
        },
        report: async () => true,
      },
      { pollMs: 2, signal: stop.signal },
    );
    setTimeout(() => stop.abort(), 30);
    const run = await pending;
    expect(run.executed).toBe(0);
    expect(run.iterations).toBeGreaterThanOrEqual(1);
    expect(run.stoppedBy).toBe('signal');
  });

  it('stops promptly when aborted during the poll interval', async () => {
    const stop = new AbortController();
    const began = Date.now();
    const pending = runWorkerLoop(
      {
        poll: async () => null,
        execute: async () => ({ state: 'FAILED', reason: 'x' }),
        report: async () => true,
      },
      { pollMs: 10_000, signal: stop.signal },
    );
    setTimeout(() => stop.abort(), 20);
    const run = await pending;
    expect(Date.now() - began).toBeLessThan(1000);
    expect(run.stoppedBy).toBe('signal');
  });

  it('retries a transient poll failure', async () => {
    const stop = new AbortController();
    let calls = 0;
    const run = await runWorkerLoop(
      {
        poll: async () => {
          calls++;
          if (calls === 1) throw new Error('network');
          stop.abort();
          return null;
        },
        execute: async () => ({ state: 'FAILED', reason: 'x' }),
        report: async () => true,
      },
      { pollMs: 1, signal: stop.signal },
    );
    expect(calls).toBe(2);
    expect(run.pollFailures).toBe(0); // reset by the successful poll
    expect(run.stoppedBy).toBe('signal');
  });

  it('gives up after consecutive poll failures instead of spinning forever', async () => {
    const stop = new AbortController();
    let calls = 0;
    const run = await runWorkerLoop(
      {
        poll: async () => {
          calls++;
          throw new Error('coordinator down');
        },
        execute: async () => ({ state: 'FAILED', reason: 'x' }),
        report: async () => true,
      },
      { pollMs: 1, signal: stop.signal, maxPollFailures: 2 },
    );
    expect(calls).toBe(2);
    expect(run.stoppedBy).toBe('poll-failures');
  });

  it('reports an execution failure as FAILED and never retries the shard', async () => {
    const stop = new AbortController();
    const outcomes: string[] = [];
    let served = false;
    await runWorkerLoop(
      {
        poll: async () => {
          if (served) {
            stop.abort();
            return null;
          }
          served = true;
          return assignment();
        },
        execute: async () => {
          throw new Error('engine exploded');
        },
        report: async (_item, outcome) => {
          outcomes.push(outcome.state);
          return true;
        },
      },
      { pollMs: 1, signal: stop.signal },
    );
    expect(outcomes).toEqual(['FAILED']);
  });

  it('tolerates a failed report: the lease expires instead', async () => {
    const stop = new AbortController();
    const events: string[] = [];
    let served = false;
    const run = await runWorkerLoop(
      {
        poll: async () => {
          if (served) {
            stop.abort();
            return null;
          }
          served = true;
          return assignment();
        },
        execute: async () => ({ state: 'SUCCEEDED', reason: 'completed' }),
        report: async () => {
          throw new Error('coordinator gone');
        },
      },
      { pollMs: 1, signal: stop.signal, onEvent: (event) => events.push(event) },
    );
    expect(run.reported).toBe(0);
    expect(events).toContain('worker.report_failed');
  });
});
