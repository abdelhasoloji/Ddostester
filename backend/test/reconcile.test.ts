import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { reconcileOrphanedRuns } from '../src/runtime/reconcile.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

function campaign(id: string, status: Campaign['status']): Campaign {
  return {
    id,
    name: id,
    status,
    target: 'http://127.0.0.1/',
    probeUrl: 'http://127.0.0.1/',
    vector: 'http-get',
    maxRps: 10,
    concurrency: 2,
    maxDurationSec: 10,
    authorized: true,
    createdBy: 'eng',
    createdAt: new Date().toISOString(),
  } as Campaign;
}

describe('reconcileOrphanedRuns', () => {
  it('resets a stuck RUNNING campaign to APPROVED and leaves others untouched', async () => {
    const store = new MemoryStore();
    await store.saveCampaign(campaign('stuck', 'RUNNING'));
    await store.saveCampaign(campaign('done', 'COMPLETED'));
    await store.saveCampaign(campaign('pend', 'PENDING_APPROVAL'));

    const reset = await reconcileOrphanedRuns(store);
    expect(reset).toBe(1);

    const stuck = await store.getCampaign('stuck');
    expect(stuck?.status).toBe('APPROVED');
    expect(stuck?.statusDetail).toMatch(/restart/i);
    expect((await store.getCampaign('done'))?.status).toBe('COMPLETED');
    expect((await store.getCampaign('pend'))?.status).toBe('PENDING_APPROVAL');
  });
});
