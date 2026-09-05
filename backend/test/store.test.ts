import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

function run(id: string, finishedAt: string): CampaignRun {
  return {
    runId: id,
    campaignId: 'c1',
    status: 'COMPLETED',
    generator: { id, finishedAt, totalRequests: 1, failed: 0 },
    probe: { samples: 1, available: 1, successful: 1, errorRate5xx: 0 },
    wrs: { wrs: 90, level: 'A' },
  } as CampaignRun;
}

describe('MemoryStore retention', () => {
  it('healthy() is true', async () => {
    expect(await new MemoryStore().healthy()).toBe(true);
  });

  it('prunes runs and audit older than the retention window, keeps recent', async () => {
    const s = new MemoryStore();
    await s.saveCampaign({ id: 'c1', createdAt: daysAgo(200) } as Campaign);
    await s.saveRun(run('old', daysAgo(120)));
    await s.saveRun(run('recent', daysAgo(10)));
    await s.saveAudit({ id: 'a-old', at: daysAgo(120), actor: 'x', action: 'campaign.create' });
    await s.saveAudit({ id: 'a-new', at: daysAgo(1), actor: 'x', action: 'campaign.create' });

    const removed = await s.pruneOldData(90);
    expect(removed.runs).toBe(1);
    expect(removed.audit).toBe(1);
    expect(await s.getRun('old')).toBeUndefined();
    expect(await s.getRun('recent')).toBeDefined();
    expect((await s.listAudit()).map((a) => a.id)).toEqual(['a-new']);
  });
});
