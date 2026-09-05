import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
import type { User } from '../auth/users.js';

/**
 * Persistence layer. Two implementations: memory (dev/tests) and PostgreSQL
 * (production). Campaigns and runs are persisted; active kill switches (runtime
 * objects) live in a separate registry (runtime/kills).
 */
export interface Store {
  readonly backend: 'memory' | 'postgres';
  init(): Promise<void>;
  saveCampaign(c: Campaign): Promise<void>;
  getCampaign(id: string): Promise<Campaign | undefined>;
  listCampaigns(): Promise<Campaign[]>;
  saveRun(r: CampaignRun): Promise<void>;
  getRun(runId: string): Promise<CampaignRun | undefined>;
  /** Run history (all, or filtered by campaign), newest first. */
  listRuns(campaignId?: string): Promise<CampaignRun[]>;
  saveAudit(e: AuditEntry): Promise<void>;
  listAudit(limit?: number): Promise<AuditEntry[]>;
  /**
   * Runtime-managed users (additive to the immutable env-defined AUTH_USERS,
   * which are never stored here). Officer-managed, audited.
   */
  listUsers(): Promise<User[]>;
  getUser(email: string): Promise<User | undefined>;
  saveUser(u: User): Promise<void>;
  deleteUser(email: string): Promise<void>;
  close(): Promise<void>;
}
