import pg from 'pg';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FleetHttpAgent } from '../src/agents/fleet.js';
import { PersistentFleetHttpAgent, bindPersistentFleet } from '../src/agents/persistent-fleet.js';
import type { LoadTestConfig } from '../src/engine/types.js';
const config: LoadTestConfig = {
  url: 'http://lab-target:8080/',
  authorized: true,
  maxRps: 3,
  concurrency: 3,
  durationSec: 10,
  headers: { 'X-WEDOS-TEST': 'admission-fixture:trace' },
};
let release: (() => void) | undefined;
beforeEach(() => {
  vi.stubEnv('FLEET_ENABLED', '1');
  vi.stubEnv('FLEET_AGENT_IMAGE', 'fixture@sha256:inert');
  vi.stubEnv('DATABASE_URL', 'postgres://never-connect.invalid/fixture');
  vi.stubEnv('KUBERNETES_SERVICE_HOST', 'never-connect.invalid');
  vi.spyOn(pg, 'Pool').mockImplementation(function () {
    throw Error('Unexpected database access in rejected admission');
  });
});
afterEach(() => {
  release?.();
  release = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('advertises unavailable configuration and rejects it without falling back to local generation', async () => {
  const agent = new FleetHttpAgent();
  for (const key of ['FLEET_AGENT_IMAGE', 'DATABASE_URL', 'KUBERNETES_SERVICE_HOST']) {
    const previous = process.env[key]!;
    vi.stubEnv(key, '');
    expect(await agent.available()).toBe(false);
    await expect(agent.run(config, ['lab-target'])).rejects.toThrow('no builtin fallback');
    vi.stubEnv(key, previous);
  }
  vi.stubEnv('FLEET_ENABLED', '0');
  expect(await agent.available()).toBe(false);
  expect(pg.Pool).not.toHaveBeenCalled();
});
it('refuses incompatible campaign capabilities before database or Kubernetes work is created', async () => {
  const start = vi.fn();
  release = bindPersistentFleet({ start, stop: vi.fn(), snapshot: vi.fn() });
  const cases: Partial<LoadTestConfig>[] = [
    { method: 'POST' },
    { body: 'payload' },
    { phases: [{ maxRps: 3, durationSec: 10 }] },
    { flow: [{ method: 'GET', url: config.url }] },
    { endpoints: [{ url: config.url }] },
    { userAgents: ['fixture'] },
    { dataset: [{ sensor: 'fixture' }] },
    { assertion: { status: 200 } },
    { cacheBust: true },
    { noKeepAlive: true },
    { parallelism: 2 },
    { slowloris: true },
  ];
  for (const patch of cases)
    for (const agent of [new FleetHttpAgent(), new PersistentFleetHttpAgent()])
      await expect(agent.run({ ...config, ...patch }, ['lab-target'])).rejects.toThrow(
        /plain bounded GET|single bounded GET/,
      );
  expect(start).not.toHaveBeenCalled();
  expect(pg.Pool).not.toHaveBeenCalled();
});
it('refuses undersized or oversized shared budgets, invalid target path, missing parent and cancelled preparation', async () => {
  const start = vi.fn();
  release = bindPersistentFleet({ start, stop: vi.fn(), snapshot: vi.fn() });
  for (const patch of [
    { maxRps: 2 },
    { maxRps: 16 },
    { concurrency: 2 },
    { concurrency: 7 },
    { durationSec: 9 },
    { durationSec: 61 },
  ])
    for (const agent of [new FleetHttpAgent(), new PersistentFleetHttpAgent()])
      await expect(agent.run({ ...config, ...patch }, ['lab-target'])).rejects.toThrow(/envelope/i);
  await expect(
    new FleetHttpAgent().run({ ...config, url: 'http://lab-target:8080/unreviewed' }, [
      'lab-target',
    ]),
  ).rejects.toThrow('dedicated lab target');
  await expect(
    new FleetHttpAgent().run({ ...config, headers: {} }, ['lab-target']),
  ).rejects.toThrow('Parent campaign identity');
  await expect(new FleetHttpAgent().run(config, ['lab-target'])).rejects.toThrow(
    'interactive authenticated',
  );
  const abort = AbortSignal.abort();
  for (const agent of [new FleetHttpAgent(), new PersistentFleetHttpAgent()])
    await expect(agent.run(config, ['lab-target'], abort)).rejects.toThrow(/cancelled before/);
  expect(start).not.toHaveBeenCalled();
  expect(pg.Pool).not.toHaveBeenCalled();
});

it('requires a managed session version even when an actor is present', async () => {
  const { mutationActor } = await import('../src/store/audited.js');
  await expect(
    mutationActor.run('admin-fixture', () => new FleetHttpAgent().run(config, ['lab-target'])),
  ).rejects.toThrow('interactive authenticated');
  await expect(
    new FleetHttpAgent().run(
      { ...config, url: 'http://lab-target:8080/health', headers: undefined },
      ['lab-target'],
    ),
  ).rejects.toThrow('Parent campaign');
  expect(pg.Pool).not.toHaveBeenCalled();
});
