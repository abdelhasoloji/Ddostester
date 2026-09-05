import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
import type { User } from '../auth/users.js';
import type { Playbook } from '../modules/playbooks/playbooks.js';
import type { Store } from './types.js';

export class MemoryStore implements Store {
  readonly backend = 'memory' as const;
  private campaigns = new Map<string, Campaign>();
  private runs = new Map<string, CampaignRun>();
  private audit: AuditEntry[] = [];
  private users = new Map<string, User>();
  private playbooks = new Map<string, Playbook>();

  async init(): Promise<void> {}
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
    this.audit.push(e);
  }
  async listAudit(limit = 200): Promise<AuditEntry[]> {
    return [...this.audit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
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
  async close(): Promise<void> {}
}
