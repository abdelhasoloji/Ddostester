import pg from 'pg';
import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
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

  /** true si l'extension TimescaleDB est disponible (wrs_samples devient hypertable). */
  private timescale = false;

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
      CREATE TABLE IF NOT EXISTS audit (
        id          uuid PRIMARY KEY,
        at          timestamptz NOT NULL,
        actor       text NOT NULL,
        action      text NOT NULL,
        campaign_id uuid,
        detail      text
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);
      -- Séries temporelles WRS (append-only) : hypertable si TimescaleDB présent.
      CREATE TABLE IF NOT EXISTS wrs_samples (
        at      timestamptz NOT NULL DEFAULT now(),
        target  text NOT NULL,
        wrs     double precision NOT NULL,
        level   text NOT NULL,
        run_id  uuid NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wrs_samples ON wrs_samples(target, at DESC);
    `);

    // Active TimescaleDB si disponible (sinon PostgreSQL standard, table normale).
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
      await this.pool.query(
        "SELECT create_hypertable('wrs_samples', 'at', if_not_exists => TRUE, migrate_data => TRUE)",
      );
      this.timescale = true;
    } catch {
      this.timescale = false;
    }
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
    // Point de série temporelle WRS (hypertable si TimescaleDB).
    let host = target;
    try {
      host = new URL(target).hostname;
    } catch {
      /* garde brut */
    }
    await this.pool.query(
      'INSERT INTO wrs_samples (at, target, wrs, level, run_id) VALUES (now(),$1,$2,$3,$4)',
      [host, run.wrs.wrs, run.wrs.level, run.runId],
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

  async saveAudit(e: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit (id, at, actor, action, campaign_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.id, e.at, e.actor, e.action, e.campaignId ?? null, e.detail ?? null],
    );
  }

  async listAudit(limit = 200): Promise<AuditEntry[]> {
    const r = await this.pool.query(
      `SELECT id, at, actor, action, campaign_id AS "campaignId", detail
       FROM audit ORDER BY at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({
      id: x.id,
      at: (x.at instanceof Date ? x.at.toISOString() : String(x.at)),
      actor: x.actor,
      action: x.action,
      campaignId: x.campaignId ?? undefined,
      detail: x.detail ?? undefined,
    })) as AuditEntry[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
