import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PostgresStore } from '../src/store/postgres.js';
import { SyntheticCoordinator } from '../src/modules/bench/journey.js';
const url = process.env.DATABASE_URL_TEST;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !url) throw Error('DATABASE_URL_TEST required');
(url ? describe : describe.skip)('Synthetic PostgreSQL atomic admission and restart', () => {
  const schema = 'synthetic_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url });
  let one: PostgresStore, two: PostgresStore;
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set('options', '-c search_path=' + schema);
    one = new PostgresStore(scoped.toString());
    two = new PostgresStore(scoped.toString());
    await one.init();
    await two.init();
  });
  afterAll(async () => {
    await one?.close();
    await two?.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  it('serializes competing starts and persists the stop-on-restart final report without replay', async () => {
    const a = new SyntheticCoordinator(one, () => true, ['127.0.0.1']);
    const b = new SyntheticCoordinator(two, () => true, ['127.0.0.1']);
    const input = {
      name: 'Persistent synthetic',
      targetLevel: 5,
      intervalSec: 0,
      labTarget: '127.0.0.1',
      authorized: true,
    };
    const x = await a.create(input, 'operator'),
      y = await b.create(input, 'operator');
    const results = await Promise.allSettled([
      a.control(x.id, 'start', 'operator', {
        confirmed: true,
        planHash: x.syntheticJourney!.planHash,
      }),
      b.control(y.id, 'start', 'operator', {
        confirmed: true,
        planHash: y.syntheticJourney!.planHash,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const c = (await one.listCampaigns()).find((c) => c.syntheticJourney?.state === 'RUNNING')!;
    const run = await a.claim('runner');
    expect(run?.status).toBe('CLAIMED');
    await a.close();
    await b.close();
    const restarted = new SyntheticCoordinator(two, () => true, ['127.0.0.1']);
    await restarted.reconcile();
    await restarted.tick();
    expect((await two.getCampaign(c.id))!.syntheticJourney!.state).toBe('STOPPING');
    await two.setBenchRunResult(run!.id, { error: 'Runner unavailable after restart' });
    await restarted.tick();
    const saved = (await one.getCampaign(c.id))!;
    expect(saved.syntheticJourney!.state).toBe('CANCELLED');
    expect(saved.syntheticJourney!.steps).toHaveLength(60);
    expect(saved.syntheticJourney!.steps.every((s) => s.result?.kind === 'NOT_EVALUATED')).toBe(
      true,
    );
    expect(saved.syntheticJourney!.definition.entries?.[59].referenceHash).toBeTruthy();
    expect(saved.drsDocument!.revisions[0].finalizedAt).toBeTruthy();
    expect(await one.listBenchRuns()).toHaveLength(1);
    expect(saved.syntheticJourney!.steps.filter((s) => s.runId)).toHaveLength(1);
    await restarted.close();
  });
  it('finds old active requests behind more than a page of newer terminal records', async () => {
    const make = () => ({
      id: randomUUID(),
      scenario: 'tcp_synflood',
      labTarget: '127.0.0.1',
      requestedBy: 'qa',
      requestedAt: new Date().toISOString(),
      status: 'REQUESTED' as const,
    });
    const pending = make();
    await one.createBenchRun(pending);
    for (let i = 0; i < 101; i++) {
      const r = make();
      await one.createBenchRun(r);
      await one.setBenchRunResult(r.id, { error: 'Fixture terminal record' });
    }
    expect((await two.listBenchRuns(1, true))[0].id).toBe(pending.id);
  });
});
