import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { Store } from './types.js';

export class MemoryStore implements Store {
  readonly backend = 'memory' as const;
  private campaigns = new Map<string, Campaign>();
  private runs = new Map<string, CampaignRun>();

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
  async close(): Promise<void> {}
}
