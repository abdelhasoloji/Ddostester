import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';

/**
 * Couche de persistance. Deux implémentations : mémoire (dev/tests) et
 * PostgreSQL (production). Les campagnes et les runs sont persistés ; les kill
 * switches actifs (objets runtime) vivent dans un registre séparé (runtime/kills).
 */
export interface Store {
  readonly backend: 'memory' | 'postgres';
  init(): Promise<void>;
  saveCampaign(c: Campaign): Promise<void>;
  getCampaign(id: string): Promise<Campaign | undefined>;
  listCampaigns(): Promise<Campaign[]>;
  saveRun(r: CampaignRun): Promise<void>;
  getRun(runId: string): Promise<CampaignRun | undefined>;
  /** Historique des runs (tous, ou filtrés par campagne), du plus récent au plus ancien. */
  listRuns(campaignId?: string): Promise<CampaignRun[]>;
  close(): Promise<void>;
}
