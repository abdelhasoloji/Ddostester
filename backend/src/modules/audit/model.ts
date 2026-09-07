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
    | 'user.delete'
    | 'playbook.upsert'
    | 'playbook.delete'
    | 'share.create'
    | 'drs.verdict';
  campaignId?: string;
  detail?: string;
  /**
   * Tamper-evidence (EPIC D): hash of this entry chained onto the previous
   * entry's hash, and the previous hash it was chained onto. Filled by the
   * store at write time; absent on rows written before the chain existed.
   */
  hash?: string;
  prevHash?: string;
}
