import { expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { SyntheticCoordinator } from '../src/modules/bench/journey.js';
import { drsReport } from '../src/modules/drs/report.js';
import type { Store } from '../src/store/types.js';
import type { BenchRun } from '../src/modules/bench/model.js';
const input = {
  name: 'Synthetic QA',
  targetLevel: 5,
  intervalSec: 2,
  labTarget: '127.0.0.1',
  authorized: true,
};
async function complete(store: Store, run: BenchRun) {
  await store.transaction((tx) =>
    tx.setBenchRunResult(run.id, {
      verdict: {
        schema: 'shieldtest.lab.verdict/v1',
        class: 'C',
        scenario: run.scenario,
        kind: 'udp-amplification',
        target: { packets: 10, avgPps: 2, avgBps: 120 },
        amplificationFactor: 300,
        outcome: 'UNMITIGATED_BASELINE',
      },
    }),
  );
}
function fixture() {
  const store = new MemoryStore();
  let now = Date.now(),
    enabled = true;
  const coordinator = new SyntheticCoordinator(
    store,
    () => enabled,
    ['127.0.0.1'],
    () => now,
  );
  return {
    store,
    coordinator,
    advance: (ms: number) => {
      now += ms;
    },
    disable: () => {
      enabled = false;
    },
  };
}
async function started(f: ReturnType<typeof fixture>) {
  const c = await f.coordinator.create(input, 'operator');
  await expect(
    f.coordinator.control(c.id, 'start', 'operator', {
      confirmed: false,
      planHash: c.syntheticJourney!.planHash,
    }),
  ).rejects.toThrow(/confirm/);
  await f.coordinator.control(c.id, 'start', 'operator', {
    confirmed: true,
    planHash: c.syntheticJourney!.planHash,
  });
  return c.id;
}
it('automatically sequences the registered shapes and finalizes an honest diagnostic report exactly once', async () => {
  const f = fixture(),
    id = await started(f);
  expect((await f.store.getCampaign(id))!.syntheticJourney!.steps).toHaveLength(5);
  for (let i = 0; i < 5; i++) {
    expect(await f.store.listBenchRuns()).toHaveLength(i + 1);
    const run = (await f.coordinator.claim('qa'))!;
    expect(run.status).toBe('CLAIMED');
    await complete(f.store, run);
    await f.coordinator.tick();
    await f.coordinator.tick();
    const c = (await f.store.getCampaign(id))!;
    expect(c.drsDocument!.revisions[0].attachments).toHaveLength(i + 1);
    if (i < 4) {
      expect(await f.coordinator.claim('qa')).toBeUndefined();
      f.advance(2001);
      await f.coordinator.tick();
    }
  }
  const c = (await f.store.getCampaign(id))!,
    r = drsReport(c.drsDocument!.revisions[0]);
  expect(c.status).toBe('COMPLETED');
  expect(c.syntheticJourney!.state).toBe('COMPLETED');
  expect(r.assessment.score).toBeNull();
  expect(r.assessment.status).toBe('PARTIAL');
  expect(r.proofs).toHaveLength(0);
  expect(r.plan.maxLevel).toBe(5);
  expect(r.attachments).toHaveLength(5);
  expect(r.attachments[0].measurements.actual_received_load).toEqual({ bps: 120, pps: 2 });
  expect(
    (await f.store.listAudit()).filter((a) => a.detail?.startsWith('Synthetic final report')),
  ).toHaveLength(1);
  await expect(
    f.coordinator.control(id, 'start', 'operator', {
      confirmed: true,
      planHash: c.syntheticJourney!.planHash,
    }),
  ).rejects.toThrow(/draft/);
});
it('pause prevents a queued claim and holds the next admission after current completion', async () => {
  const f = fixture(),
    id = await started(f);
  await f.coordinator.control(id, 'pause', 'operator');
  expect(await f.coordinator.claim('qa')).toBeUndefined();
  await f.coordinator.control(id, 'resume', 'operator');
  const run = (await f.coordinator.claim('qa'))!;
  await f.coordinator.control(id, 'pause', 'operator');
  await complete(f.store, run);
  await f.coordinator.tick();
  f.advance(3000);
  await f.coordinator.tick();
  expect(await f.store.listBenchRuns()).toHaveLength(1);
  await f.coordinator.control(id, 'resume', 'operator');
  expect(await f.store.listBenchRuns()).toHaveLength(2);
});
it('stop cancels an unclaimed request and produces a final cancelled report without another scenario', async () => {
  const f = fixture(),
    id = await started(f);
  await f.coordinator.control(id, 'stop', 'operator');
  expect(await f.coordinator.claim('qa')).toBeUndefined();
  const c = (await f.store.getCampaign(id))!;
  expect(c.status).toBe('CANCELLED');
  expect(c.syntheticJourney!.state).toBe('CANCELLED');
  expect(c.drsDocument!.revisions[0].finalizedAt).toBeTruthy();
  expect(await f.store.listBenchRuns()).toHaveLength(1);
});
it('stop waits for an already claimed bounded run and preserves its eventual observation', async () => {
  const f = fixture(),
    id = await started(f),
    run = (await f.coordinator.claim('qa'))!;
  await f.coordinator.control(id, 'stop', 'operator');
  expect((await f.store.getCampaign(id))!.syntheticJourney!.state).toBe('STOPPING');
  await complete(f.store, run);
  await f.coordinator.tick();
  const c = (await f.store.getCampaign(id))!;
  expect(c.status).toBe('CANCELLED');
  expect(c.drsDocument!.revisions[0].attachments).toHaveLength(1);
  expect(await f.store.listBenchRuns()).toHaveLength(1);
});
it.each([false, true])(
  'times out unavailable runners without replay or a fake success (claimed=%s)',
  async (claimed) => {
    const f = fixture(),
      id = await started(f);
    if (claimed) await f.coordinator.claim('qa');
    f.advance(181000);
    await f.coordinator.tick();
    const c = (await f.store.getCampaign(id))!;
    expect(c.syntheticJourney!.state).toBe('FAILED');
    expect(c.status).toBe('CANCELLED');
    expect(c.drsDocument!.revisions[0].finalizedAt).toBeTruthy();
    expect(await f.coordinator.claim('qa')).toBeUndefined();
    expect(await f.store.listBenchRuns()).toHaveLength(1);
  },
);
it('restart cancels future admissions while retaining and settling the claimed observation', async () => {
  const f = fixture(),
    id = await started(f),
    run = (await f.coordinator.claim('qa'))!;
  const restarted = new SyntheticCoordinator(f.store, () => true, ['127.0.0.1']);
  await restarted.reconcile();
  await restarted.tick();
  expect((await f.store.getCampaign(id))!.syntheticJourney!.state).toBe('STOPPING');
  await complete(f.store, run);
  await restarted.tick();
  expect((await f.store.getCampaign(id))!.status).toBe('CANCELLED');
  expect(await f.store.listBenchRuns()).toHaveLength(1);
});
it('fails closed for missing targets, lost configuration, busy bench, concurrent starts and changed plans', async () => {
  const f = fixture();
  await expect(
    f.coordinator.create({ ...input, labTarget: 'example.com' }, 'op'),
  ).rejects.toThrow();
  await expect(f.coordinator.create({ ...input, authorized: false }, 'op')).rejects.toThrow();
  const id = await started(f),
    other = await f.coordinator.create(input, 'op');
  await expect(
    f.coordinator.control(other.id, 'start', 'op', {
      confirmed: true,
      planHash: other.syntheticJourney!.planHash,
    }),
  ).rejects.toThrow(/active|busy/);
  f.disable();
  await f.coordinator.tick();
  expect((await f.store.getCampaign(id))!.status).toBe('CANCELLED');
  await f.coordinator.close();
});
it('preserves separate approval and signoff and never accepts a stale reviewed hash', async () => {
  const f = fixture(),
    c = await f.coordinator.create(input, 'author');
  const opts = { confirmed: true, planHash: c.syntheticJourney!.planHash, requireApproval: true };
  await expect(f.coordinator.control(c.id, 'start', 'author', opts)).rejects.toThrow(/approval/);
  await f.store.saveCampaign({ ...c, status: 'APPROVED', approvedBy: 'reviewer' });
  await expect(
    f.coordinator.control(c.id, 'start', 'author', { ...opts, requireCiso: true }),
  ).rejects.toThrow(/sign-off/);
  await expect(
    f.coordinator.control(c.id, 'start', 'author', { ...opts, planHash: 'stale' }),
  ).rejects.toThrow(/confirm/);
  expect(await f.store.listBenchRuns()).toHaveLength(0);
  await f.coordinator.control(c.id, 'start', 'author', opts);
  expect(await f.store.listBenchRuns()).toHaveLength(1);
});
