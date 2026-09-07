import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
import { AUDIT_GENESIS, chainEntry } from '../modules/audit/integrity.js';
import type { User } from '../auth/users.js';
import type { Playbook } from '../modules/playbooks/playbooks.js';
import type { OperationalLimits } from '../config/limits.js';
import type { Store } from './types.js';

export class MemoryStore implements Store {
  readonly backend = 'memory' as const;
  private campaigns = new Map<string, Campaign>();
  private runs = new Map<string, CampaignRun>();
  private audit: AuditEntry[] = [];
  private users = new Map<string, User>();
  private playbooks = new Map<string, Playbook>();
  private limits: OperationalLimits | undefined;

  async init(): Promise<void> {}
  async healthy(): Promise<boolean> {
    return true;
  }
  async pruneOldData(
    olderThanDays: number,
  ): Promise<{ runs: number; audit: number; samples: number }> {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    let runs = 0;
    for (const [id, r] of this.runs) {
      const at = Date.parse(r.generator.finishedAt);
      if (Number.isFinite(at) && at < cutoff) {
        this.runs.delete(id);
        runs++;
      }
    }
    const before = this.audit.length;
    this.audit = this.audit.filter((e) => Date.parse(e.at) >= cutoff);
    return { runs, audit: before - this.audit.length, samples: 0 };
  }
  async saveCampaign(c: Campaign): Promise<void> {
    this.campaigns.set(c.id, c);
  }
  async getCampaign(id: string): Promise<Campaign | undefined> {
    return this.campaigns.get(id);
  }
  async listCampaigns(): Promise<Campaign[]> {
    return [...this.campaigns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async saveRun(r: CampaignRun): Promise<void> {
    this.runs.set(r.runId, r);
  }
  async getRun(runId: string): Promise<CampaignRun | undefined> {
    return this.runs.get(runId);
  }
  async listRuns(campaignId?: string): Promise<CampaignRun[]> {
    return [...this.runs.values()].filter((r) => !campaignId || r.campaignId === campaignId);
  }
  async saveAudit(e: AuditEntry): Promise<void> {
    const prev = this.audit.length
      ? (this.audit[this.audit.length - 1].hash ?? AUDIT_GENESIS)
      : AUDIT_GENESIS;
    this.audit.push(chainEntry(e, prev));
  }
  async listAudit(limit = 200): Promise<AuditEntry[]> {
    return [...this.audit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
  async listAuditChain(): Promise<AuditEntry[]> {
    return [...this.audit];
  }
  async listUsers(): Promise<User[]> {
    return [...this.users.values()].sort((a, b) => a.email.localeCompare(b.email));
  }
  async getUser(email: string): Promise<User | undefined> {
    return this.users.get(email.toLowerCase());
  }
  async saveUser(u: User): Promise<void> {
    this.users.set(u.email.toLowerCase(), u);
  }
  async deleteUser(email: string): Promise<void> {
    this.users.delete(email.toLowerCase());
  }
  async listPlaybooks(): Promise<Playbook[]> {
    return [...this.playbooks.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async getPlaybook(id: string): Promise<Playbook | undefined> {
    return this.playbooks.get(id);
  }
  async savePlaybook(p: Playbook): Promise<void> {
    this.playbooks.set(p.id, p);
  }
  async deletePlaybook(id: string): Promise<void> {
    this.playbooks.delete(id);
  }
  async getLimits(): Promise<OperationalLimits | undefined> {
    return this.limits ? { ...this.limits } : undefined;
  }
  async setLimits(limits: OperationalLimits): Promise<void> {
    this.limits = { ...limits };
  }
  async close(): Promise<void> {}
}
