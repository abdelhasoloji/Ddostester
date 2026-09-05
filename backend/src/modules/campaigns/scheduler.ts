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
