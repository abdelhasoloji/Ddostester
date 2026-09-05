import pg from 'pg';
import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { Store } from './types.js';

const { Pool } = pg;

/**
 * Persistance PostgreSQL. Les objets Campaign / CampaignRun sont stockés en
 * jsonb (souples), avec quelques colonnes dédiées pour le filtrage et l'ordre
 * (statut, cible, WRS, dates) — base d'un historique WRS par cible (TSD §5.4).
 */
export class PostgresStore implements Store {
  readonly backend = 'postgres' as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id          uuid PRIMARY KEY,
        name        text NOT NULL,
        status      text NOT NULL,
        target      text NOT NULL,
        created_by  text NOT NULL,
        created_at  timestamptz NOT NULL,
        data        jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id      uuid PRIMARY KEY,
        campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        target      text NOT NULL,
        status      text NOT NULL,
        wrs         numeric,
        wrs_level   text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        data        jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_campaign ON runs(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_runs_target ON runs(target, created_at DESC);
    `);
  }

  async saveCampaign(c: Campaign): Promise<void> {
    await this.pool.query(
      `INSERT INTO campaigns (id, name, status, target, created_by, created_at, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, status=$3, target=$4, created_by=$5, created_at=$6, data=$7`,
      [c.id, c.name, c.status, c.target, c.createdBy, c.createdAt, JSON.stringify(c)],
    );
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    const r = await this.pool.query<{ data: Campaign }>('SELECT data FROM campaigns WHERE id=$1', [id]);
    return r.rows[0]?.data;
  }

  async listCampaigns(): Promise<Campaign[]> {
    const r = await this.pool.query<{ data: Campaign }>('SELECT data FROM campaigns ORDER BY created_at DESC');
    return r.rows.map((x) => x.data);
  }

  async saveRun(run: CampaignRun): Promise<void> {
    const target = (await this.getCampaign(run.campaignId))?.target ?? '';
    await this.pool.query(
      `INSERT INTO runs (run_id, campaign_id, target, status, wrs, wrs_level, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id) DO UPDATE SET
         status=$4, wrs=$5, wrs_level=$6, data=$7`,
      [run.runId, run.campaignId, target, run.status, run.wrs.wrs, run.wrs.level, JSON.stringify(run)],
    );
  }

  async getRun(runId: string): Promise<CampaignRun | undefined> {
    const r = await this.pool.query<{ data: CampaignRun }>('SELECT data FROM runs WHERE run_id=$1', [runId]);
    return r.rows[0]?.data;
  }

  async listRuns(campaignId?: string): Promise<CampaignRun[]> {
    const r = campaignId
      ? await this.pool.query<{ data: CampaignRun }>(
          'SELECT data FROM runs WHERE campaign_id=$1 ORDER BY created_at DESC',
          [campaignId],
        )
      : await this.pool.query<{ data: CampaignRun }>('SELECT data FROM runs ORDER BY created_at DESC');
    return r.rows.map((x) => x.data);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
