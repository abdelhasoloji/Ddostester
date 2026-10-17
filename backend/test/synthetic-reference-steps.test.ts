import { freeze } from '../src/modules/drs/workflow.js';
import { it, expect } from 'vitest';
import { SyntheticCoordinator, syntheticDefinition } from '../src/modules/bench/journey.js';
import { simulateReference } from '../src/modules/bench/scenario-plan.js';
import { drsReference } from '../src/modules/drs/reference.js';
import { MemoryStore } from '../src/store/memory.js';
import { drsReport, drsReportHtml } from '../src/modules/drs/report.js';
const input = {
  name: 'All DRS references',
  targetLevel: 5,
  intervalSec: 2,
  labTarget: '127.0.0.1',
  authorized: true,
};
it('retains exactly 60 reference rows and immutable source requirements, without deduplication', () => {
  const d = syntheticDefinition(5, 2, '127.0.0.1'),
    entries = d.entries!;
  expect(entries).toHaveLength(60);
  expect(entries.filter((e) => e.execution === 'LAB_MEASUREMENT')).toHaveLength(15);
  expect(entries.filter((e) => e.execution === 'SIMULATION')).toHaveLength(45);
  expect(new Set(entries.map((e) => e.vectorId)).size).toBe(60);
  expect(entries.map((e) => e.referenceVector)).toEqual(
    drsReference()
      .vectors.filter((v) => v.level <= 5)
      .sort((a, b) => a.level - b.level),
  );
  expect(() => syntheticDefinition(6, 0, '127.0.0.1')).toThrow(/1–5/);
  const sim = entries.find((e) => e.execution === 'SIMULATION')!;
  expect(simulateReference(sim, 'fixture')).toMatchObject({
    kind: 'SIMULATION',
    receivedBps: null,
    drsScoreEligible: false,
    model: 'reference-lifecycle/1',
  });
  expect(() => simulateReference({ ...sim, referenceHash: 'tampered' }, 'fixture')).toThrow();
});
it('runs all 60 steps separately and exports per-row simulations and real observations without creating DRS passes', async () => {
  const store = new MemoryStore();
  let now = Date.now();
  const co = new SyntheticCoordinator(
    store,
    () => true,
    ['127.0.0.1'],
    () => now,
  );
  const c = await co.create(input, 'operator');
  await co.control(c.id, 'start', 'operator', {
    confirmed: true,
    planHash: c.syntheticJourney!.planHash,
  });
  let claims = 0;
  for (let turns = 0; turns < 180; turns++) {
    const run = await co.claim('unit-runner');
    if (run) {
      claims++;
      await store.setBenchRunResult(run.id, {
        verdict: {
          schema: 'shieldtest.lab.verdict/v1',
          class: 'C',
          scenario: run.scenario,
          outcome: 'FIXTURE_OBSERVATION',
          target: { avgBps: 123, packets: 5 },
        },
      });
    }
    await co.tick();
    const fresh = (await store.getCampaign(c.id))!;
    if (fresh.syntheticJourney!.state === 'COMPLETED') break;
    const before = JSON.stringify(fresh.syntheticJourney!.steps.map((s) => s.result));
    await co.tick();
    expect(
      JSON.stringify((await store.getCampaign(c.id))!.syntheticJourney!.steps.map((s) => s.result)),
    ).toBe(before);
    now += 2001;
  }
  const saved = (await store.getCampaign(c.id))!,
    j = saved.syntheticJourney!,
    revision = saved.drsDocument!.revisions[0];
  expect(j.state).toBe('COMPLETED');
  expect(claims).toBe(15);
  expect(j.steps.every((s) => s.result)).toBe(true);
  expect(j.steps.filter((s) => s.result?.kind === 'SIMULATION')).toHaveLength(45);
  expect(j.steps.filter((s) => s.runId)).toHaveLength(15);
  expect(new Set(j.steps.filter((s) => s.runId).map((s) => s.runId)).size).toBe(15);
  const report = drsReport(revision, undefined, j);
  expect(report.scenarioResults).toHaveLength(60);
  expect(report.attachments).toHaveLength(15);
  expect(report.proofs).toHaveLength(0);
  expect(report.assessment.score).toBeNull();
  expect(report.assessment.levels.reduce((n, l) => n + l.passed, 0)).toBe(0);
  for (const row of report.scenarioResults)
    if (row.execution === 'SIMULATION') {
      expect(row.result.receivedBps).toBeNull();
      expect('runId' in row.result).toBe(false);
    }
  const html = drsReportHtml(revision, undefined, j);
  expect(html.match(/data-vector-id=/g)).toHaveLength(60);
  expect(html).toContain('SIMULATION · no traffic');
  expect(html).toContain('LAB MEASUREMENT · partial shape');
  await co.close();
});
it('pause holds the next simulation and cancellation leaves a result for every unexecuted reference', async () => {
  const store = new MemoryStore();
  let now = Date.now();
  const co = new SyntheticCoordinator(
    store,
    () => true,
    ['127.0.0.1'],
    () => now,
  );
  const c = await co.create(input, 'op');
  await co.control(c.id, 'start', 'op', {
    confirmed: true,
    planHash: c.syntheticJourney!.planHash,
  });
  const run = await co.claim('runner');
  await store.setBenchRunResult(run!.id, {
    verdict: { schema: 'v1', class: 'C', outcome: 'FIXTURE', target: { avgBps: 1 } },
  });
  await co.tick();
  await co.control(c.id, 'pause', 'op');
  now += 3000;
  await co.tick();
  expect((await store.getCampaign(c.id))!.syntheticJourney!.steps[1].result).toBeUndefined();
  await co.control(c.id, 'resume', 'op');
  expect((await store.getCampaign(c.id))!.syntheticJourney!.steps[1].result?.kind).toBe(
    'SIMULATION',
  );
  await co.control(c.id, 'stop', 'op');
  const j = (await store.getCampaign(c.id))!.syntheticJourney!;
  expect(j.state).toBe('CANCELLED');
  expect(j.steps).toHaveLength(60);
  expect(j.steps.every((s) => s.result)).toBe(true);
  expect(j.steps.filter((s) => s.result?.kind === 'NOT_EVALUATED')).toHaveLength(58);
  expect(await store.listBenchRuns()).toHaveLength(1);
  await co.close();
});
it('rejects a mutated execution binding before launch and does not silently change saved v2 plans', async () => {
  const store = new MemoryStore(),
    co = new SyntheticCoordinator(store, () => true, ['127.0.0.1']);
  const c = await co.create(input, 'op');
  c.syntheticJourney!.steps[1].execution = 'LAB_MEASUREMENT';
  await store.saveCampaign(c);
  await expect(
    co.control(c.id, 'start', 'op', { confirmed: true, planHash: c.syntheticJourney!.planHash }),
  ).rejects.toThrow(/binding/);
  expect(await store.listBenchRuns()).toHaveLength(0);
  await co.close();
});
it('preserves archived legacy measured observations when adding the new per-scenario report table', async () => {
  const store = new MemoryStore(),
    co = new SyntheticCoordinator(store, () => true, ['127.0.0.1']);
  const c = await co.create(input, 'op'),
    j = c.syntheticJourney!;
  j.steps = [{ scenarioId: 'udp_maxpackets', runId: 'archived' }];
  delete j.definition.entries;
  const revision = c.drsDocument!.revisions[0];
  freeze(revision, c);
  revision.attachments = [
    {
      kind: 'network-bench',
      sourceId: 'archived',
      sourceHash: 'fixture',
      archivedAt: 'fixture',
      measurements: {},
      limitations: [],
      source: {
        id: 'archived',
        status: 'COMPLETED',
        requestedAt: 'fixture',
        verdict: { outcome: 'OBSERVED', target: { avgBps: 42 } },
      },
    },
  ];
  const report = drsReport(revision, undefined, j);
  expect(report.scenarioResults[0].result).toMatchObject({
    kind: 'LAB_MEASUREMENT',
    outcome: 'OBSERVED',
    receivedBps: 42,
    runId: 'archived',
  });
  await co.close();
});
