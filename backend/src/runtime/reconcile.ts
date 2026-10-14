import { randomUUID } from 'node:crypto';
import type { Store } from '../store/types.js';

/**
 * Reset campaigns the store still marks RUNNING at startup. The in-memory kill
 * registry is empty when the process boots, so a stored RUNNING status means a
 * previous process died mid-run (restart / crash / OOM): that run is NOT in
 * flight and can never be killed or completed — it would sit "stuck" forever and
 * the kill/cancel endpoints would 404. Reset each to APPROVED (re-runnable) with
 * a note, mirroring runCampaign's own failure path. Returns the count reset.
 */
export async function reconcileOrphanedRuns(store: Store): Promise<number> {
  const orphaned = (await store.listCampaigns()).filter((c) => c.status === 'RUNNING');
  for (const c of orphaned) {
    await store.transaction(async (tx) => {
      await tx.saveCampaign({
        ...c,
        status: c.agent === 'fleet' ? 'CANCELLED' : 'APPROVED',
        statusDetail:
          c.agent === 'fleet'
            ? 'Distributed execution interrupted by restart. Evidence is incomplete; generation is not resumed automatically. Create a fresh governed campaign.'
            : 'Interrupted by a server restart — the run was not in flight and has been reset. Re-run to execute.',
      });
      await tx.saveAudit({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: 'system',
        action: 'campaign.reconcile',
        campaignId: c.id,
        detail:
          c.agent === 'fleet'
            ? 'Interrupted fleet cancelled; no automatic replay'
            : 'Interrupted local run returned to approval state',
      });
    });
  }
  return orphaned.length;
}
