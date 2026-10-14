import { expect, it } from 'vitest';
import { cleanupFleet } from '../src/modules/fleet/cleanup.js';

it('continues cleanup after dependency and reporter failures without leaking errors', async () => {
  const attempted: string[] = [];
  const events: unknown[] = [];
  await cleanupFleet(
    'run',
    ['stop', 'job', 'connection'].map((name) => ({
      name,
      run: async () => {
        attempted.push(name);
        if (name !== 'connection') throw new Error('password=secret');
      },
    })),
    (event) => {
      events.push(event);
      throw new Error('logger unavailable');
    },
  );
  expect(attempted).toEqual(['stop', 'job', 'connection']);
  expect(events).toEqual([
    { event: 'fleet.cleanup.failed', runId: 'run', action: 'stop' },
    { event: 'fleet.cleanup.failed', runId: 'run', action: 'job' },
  ]);
  expect(JSON.stringify(events)).not.toContain('secret');
});
