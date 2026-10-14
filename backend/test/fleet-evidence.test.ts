import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
import { fleetEvidence } from '../src/modules/reports/fleet-evidence.js';
it('exports missing shards honestly and excludes parent and child transport secrets', () => {
  const generator = {
    unexpectedSecret: 'must-not-export-this',
    totalRequests: 2,
    config: {
      url: 'http://target/?secret=private',
      headers: { authorization: 'private' },
      body: 'private',
    },
  };
  const run = {
    runId: 'run',
    campaignId: 'campaign',
    status: 'COMPLETED',
    generator: {
      ...generator,
      fleet: {
        measurementComplete: false,
        shards: [
          {
            agentId: 'one',
            state: 'SUCCEEDED',
            attemptId: 'attempt',
            leaseUntil: 1,
            result: { generator, podIp: '10.0.0.1' },
          },
          { agentId: 'two', state: 'LOST', attemptId: 'other', leaseUntil: 1 },
        ],
      },
    },
  } as unknown as CampaignRun;
  const bundle = JSON.parse(JSON.stringify(fleetEvidence(run)));
  const serialized = JSON.stringify(bundle.content);
  expect(serialized).not.toContain('private');
  expect(serialized).not.toContain('must-not-export-this');
  expect(bundle.content.fleet.measurementComplete).toBe(false);
  expect(bundle.content.fleet.shards[1].result).toBeUndefined();
  expect(createHash('sha256').update(serialized).digest('hex')).toBe(bundle.sha256);
  bundle.content.generator.totalRequests = 3;
  expect(createHash('sha256').update(JSON.stringify(bundle.content)).digest('hex')).not.toBe(
    bundle.sha256,
  );
});
