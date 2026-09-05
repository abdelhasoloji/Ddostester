import type { Campaign } from './model.js';

/**
 * Selects the campaigns to run now (CAM-01): approved, with a due scheduled
 * window, whose approval has not expired. Pure function (testable); the
 * orchestration (timer) lives in the server.
 */
export function dueCampaigns(campaigns: Campaign[], nowMs: number): Campaign[] {
  return campaigns.filter((c) => {
    if (c.status !== 'APPROVED' || !c.scheduledAt) return false;
    const at = Date.parse(c.scheduledAt);
    if (Number.isNaN(at) || at > nowMs) return false;
    if (c.approvalExpiresAt && Date.parse(c.approvalExpiresAt) < nowMs) return false;
    return true;
  });
}

/**
 * After a recurring campaign runs, computes the next scheduled time — or null
 * when it should stop. Recurrence never outlives the approval window (24 h) or
 * the optional `until`, so it can't bypass approval or separation of duties.
 */
export function reArmRecurring(c: Campaign, nowMs: number): { scheduledAt: string } | null {
  if (!c.recurrence) return null;
  const next = nowMs + c.recurrence.intervalMin * 60_000;
  if (c.recurrence.until && Date.parse(c.recurrence.until) < next) return null;
  if (c.approvalExpiresAt && Date.parse(c.approvalExpiresAt) < next) return null;
  return { scheduledAt: new Date(next).toISOString() };
}
