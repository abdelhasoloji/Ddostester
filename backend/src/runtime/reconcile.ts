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
    await store.saveCampaign({
      ...c,
      status: 'APPROVED',
      statusDetail:
        'Interrupted by a server restart — the run was not in flight and has been reset. Re-run to execute.',
    });
  }
  return orphaned.length;
}
