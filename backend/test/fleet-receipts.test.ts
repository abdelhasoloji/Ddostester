import { expect, it } from 'vitest';
import { reconcileFleetReceipts } from '../src/modules/reports/fleet-receipts.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
const run = {
  campaignId: 'campaign',
  runId: 'run',
  generator: {
    config: { url: 'http://target.test/' },
    startedAt: '2026-10-14T00:00:00Z',
    finishedAt: '2026-10-14T00:00:10Z',
    fleet: {
      shards: [
        {
          agentId: 'one',
          attemptId: 'attempt',
          result: { generator: { successful: 1, totalRequests: 1 } },
        },
      ],
    },
  },
} as unknown as CampaignRun;
const input = {
  confirmed: true,
  origin: 'http://target.test',
  records: [
    {
      trace: 'campaign:run:one:attempt',
      source: '192.0.2.1',
      status: 200,
      epochSec: Date.parse('2026-10-14T00:00:05Z') / 1000,
    },
  ],
};
it('matches only the exact run, agent, attempt and generation window', () => {
  const result = reconcileFleetReceipts(run, input, 'operator');
  expect(result.matched).toBe(true);
  expect(result.provenance).toBe('operator-imported-target-log');
  expect(result.sourceIps).toEqual(['192.0.2.1']);
  expect(result.agents[0].receipts).toBe(1);
  for (const over of [
    { trace: 'campaign:other:one:attempt' },
    { trace: 'campaign:run:one:other' },
    { epochSec: 0 },
    { source: 'invalid' },
  ])
    expect(() =>
      reconcileFleetReceipts(
        run,
        { ...input, records: [{ ...input.records[0], ...over }] },
        'operator',
      ),
    ).toThrow();
  expect(() =>
    reconcileFleetReceipts(run, { ...input, origin: 'http://outside.test' }, 'operator'),
  ).toThrow();
});
it('retains a mismatch instead of rewriting agent counters', () => {
  const result = reconcileFleetReceipts(
    run,
    { ...input, records: [{ ...input.records[0], status: 499 }] },
    'operator',
  );
  expect(result.matched).toBe(false);
  expect(result.agents[0].agentReportedSuccessful).toBe(1);
  expect(result.agents[0].successful).toBe(0);
});
