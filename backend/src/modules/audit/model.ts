/** Audit log entry (action traceability — TSD §5.5 / governance). */
export interface AuditEntry {
  id: string;
  at: string; // ISO
  actor: string; // authenticated email, or 'dev' if auth is disabled
  action:
    | 'store.mutate'
    | 'campaign.reconcile'
    | 'campaign.create'
    | 'campaign.update'
    | 'campaign.approve'
    | 'campaign.ciso_approve'
    | 'campaign.reject'
    | 'campaign.execute'
    | 'campaign.defer'
    | 'campaign.kill'
    | 'campaign.cancel'
    | 'campaign.archive'
    | 'campaign.purge'
    | 'user.single_mode'
    | 'campaign.confirm'
    | 'user.upsert'
    | 'user.delete'
    | 'user.status'
    | 'password.change'
    | 'password.reset'
    | 'user.owner.recovered'
    | 'auth.login'
    | 'auth.logout'
    | 'auth.sessions_revoke'
    | 'auth.login_locked'
    | 'playbook.upsert'
    | 'playbook.delete'
    | 'share.create'
    | 'drs.verdict'
    | 'limits.update'
    | 'bench.request'
    | 'bench.verdict'
    | 'bench.coverage'
    | 'suite.run'
    | 'suite.gate'
    | 'suite.skip'
    | 'suite.pause'
    | 'suite.resume'
    | 'suite.cancel'
    | 'assistant.pod_start'
    | 'assistant.pod_stop'
    | 'target.register'
    | 'target.update'
    | 'target.request_auth'
    | 'target.authorize'
    | 'target.revoke'
    | 'target.delete'
    | 'drs.calibration'
    | 'drs.client.create'
    | 'drs.client.update';
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
