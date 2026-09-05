/** Audit log entry (action traceability — TSD §5.5 / governance). */
export interface AuditEntry {
  id: string;
  at: string; // ISO
  actor: string; // authenticated email, or 'dev' if auth is disabled
  action:
    | 'campaign.create'
    | 'campaign.approve'
    | 'campaign.reject'
    | 'campaign.execute'
    | 'campaign.kill'
    | 'user.upsert'
    | 'user.delete';
  campaignId?: string;
  detail?: string;
}
