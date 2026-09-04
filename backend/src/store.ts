import type { Campaign } from './modules/campaigns/model.js';
import type { CampaignRun } from './modules/campaigns/runner.js';
import type { KillSwitch } from './modules/probe/probe.js';

/** Stockage en mémoire (MVP). Le TSD prévoit PostgreSQL + TimescaleDB. */
const campaigns = new Map<string, Campaign>();
const runs = new Map<string, CampaignRun>();
/** Kill switches des campagnes en cours d'exécution (pour l'arrêt manuel). */
const activeKills = new Map<string, KillSwitch>();

export const store = {
  saveCampaign: (c: Campaign): void => void campaigns.set(c.id, c),
  getCampaign: (id: string): Campaign | undefined => campaigns.get(id),
  listCampaigns: (): Campaign[] =>
    [...campaigns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),

  saveRun: (r: CampaignRun): void => void runs.set(r.runId, r),
  getRun: (id: string): CampaignRun | undefined => runs.get(id),

  setActiveKill: (campaignId: string, k: KillSwitch): void => void activeKills.set(campaignId, k),
  getActiveKill: (campaignId: string): KillSwitch | undefined => activeKills.get(campaignId),
  clearActiveKill: (campaignId: string): void => void activeKills.delete(campaignId),
};
