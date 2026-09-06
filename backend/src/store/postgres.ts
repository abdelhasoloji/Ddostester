import pg from 'pg';
import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
import { AUDIT_GENESIS, chainEntry } from '../modules/audit/integrity.js';
import type { User } from '../auth/users.js';
import type { Playbook } from '../modules/playbooks/playbooks.js';
import { isRole } from '../auth/rbac.js';
import type { Store } from './types.js';

const { Pool } = pg;

/** Advisory-lock key serializing audit-chain appends (arbitrary constant). */
const AUDIT_LOCK_KEY = 4021;

/** Maps an audit row (with chain columns) to an AuditEntry. */
function rowToAudit(x: Record<string, unknown>): AuditEntry {
  return {
    id: x.id as string,
    at: x.at instanceof Date ? x.at.toISOString() : String(x.at),
    actor: x.actor as string,
    action: x.action as AuditEntry['action'],
    campaignId: (x.campaignId as string) ?? undefined,
    detail: (x.detail as string) ?? undefined,
    prevHash: (x.prevHash as string) ?? undefined,
    hash: (x.hash as string) ?? undefined,
  };
}

/**
 * Ordered schema migrations. Each runs once, in a transaction, and is recorded
 * in `schema_migrations`. Never edit an applied migration — add a new one. The
 * baseline (id 1) uses CREATE ... IF NOT EXISTS, so it adopts an existing
 * database cleanly (re-running it is a no-op).
 */
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
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
      CREATE TABLE IF NOT EXISTS wrs_samples (
        at      timestamptz NOT NULL DEFAULT now(),
        target  text NOT NULL,
        wrs     double precision NOT NULL,
        level   text NOT NULL,
        run_id  uuid NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wrs_samples ON wrs_samples(target, at DESC);
      CREATE TABLE IF NOT EXISTS users (
        email         text PRIMARY KEY,
        role          text NOT NULL,
        password_hash text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS playbooks (
        id         text PRIMARY KEY,
        name       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        data       jsonb NOT NULL
      );
    `,
  },
  {
    // EPIC D: tamper-evident audit chain. `seq` gives a strict write order to
    // chain on; prev_hash/hash carry the chain (null on pre-existing rows).
    id: 2,
    sql: `
      ALTER TABLE audit ADD COLUMN IF NOT EXISTS seq       bigserial;
      ALTER TABLE audit ADD COLUMN IF NOT EXISTS prev_hash text;
      ALTER TABLE audit ADD COLUMN IF NOT EXISTS hash      text;
      CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit(seq);
    `,
  },
];

/**
 * PostgreSQL persistence. Campaign / CampaignRun objects are stored as jsonb
 * (flexible), with a few dedicated columns for filtering and ordering (status,
 * target, WRS, dates) — the basis of a per-target WRS history (TSD §5.4).
 */
export class PostgresStore implements Store {
  readonly backend = 'postgres' as const;
  private pool: pg.Pool;

  /** true if the TimescaleDB extension is available (wrs_samples becomes a hypertable). */
  private timescale = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.runMigrations();

    // Enable TimescaleDB if available (otherwise standard PostgreSQL, plain table).
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

  /** Applies any pending schema migrations, each once, in a transaction. */
  private async runMigrations(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id int PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await this.pool.query<{ id: number }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async pruneOldData(
    olderThanDays: number,
  ): Promise<{ runs: number; audit: number; samples: number }> {
    const cutoff = `now() - make_interval(days => $1)`;
    const runs = await this.pool.query(`DELETE FROM runs WHERE created_at < ${cutoff}`, [
      olderThanDays,
    ]);
    const audit = await this.pool.query(`DELETE FROM audit WHERE at < ${cutoff}`, [olderThanDays]);
    const samples = await this.pool.query(`DELETE FROM wrs_samples WHERE at < ${cutoff}`, [
      olderThanDays,
    ]);
    return {
      runs: runs.rowCount ?? 0,
      audit: audit.rowCount ?? 0,
      samples: samples.rowCount ?? 0,
    };
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
    const r = await this.pool.query<{ data: Campaign }>('SELECT data FROM campaigns WHERE id=$1', [
      id,
    ]);
    return r.rows[0]?.data;
  }

  async listCampaigns(): Promise<Campaign[]> {
    const r = await this.pool.query<{ data: Campaign }>(
      'SELECT data FROM campaigns ORDER BY created_at DESC',
    );
    return r.rows.map((x) => x.data);
  }

  async saveRun(run: CampaignRun): Promise<void> {
    const target = (await this.getCampaign(run.campaignId))?.target ?? '';
    await this.pool.query(
      `INSERT INTO runs (run_id, campaign_id, target, status, wrs, wrs_level, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id) DO UPDATE SET
         status=$4, wrs=$5, wrs_level=$6, data=$7`,
      [
        run.runId,
        run.campaignId,
        target,
        run.status,
        run.wrs.wrs,
        run.wrs.level,
        JSON.stringify(run),
      ],
    );
    // WRS time-series point (hypertable if TimescaleDB).
    let host = target;
    try {
      host = new URL(target).hostname;
    } catch {
      /* keep raw */
    }
    await this.pool.query(
      'INSERT INTO wrs_samples (at, target, wrs, level, run_id) VALUES (now(),$1,$2,$3,$4)',
      [host, run.wrs.wrs, run.wrs.level, run.runId],
    );
  }

  async getRun(runId: string): Promise<CampaignRun | undefined> {
    const r = await this.pool.query<{ data: CampaignRun }>(
      'SELECT data FROM runs WHERE run_id=$1',
      [runId],
    );
    return r.rows[0]?.data;
  }

  async listRuns(campaignId?: string): Promise<CampaignRun[]> {
    const r = campaignId
      ? await this.pool.query<{ data: CampaignRun }>(
          'SELECT data FROM runs WHERE campaign_id=$1 ORDER BY created_at DESC',
          [campaignId],
        )
      : await this.pool.query<{ data: CampaignRun }>(
          'SELECT data FROM runs ORDER BY created_at DESC',
        );
    return r.rows.map((x) => x.data);
  }

  async saveAudit(e: AuditEntry): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize concurrent appends so the chain never forks.
      await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);
      const head = await client.query<{ hash: string | null }>(
        'SELECT hash FROM audit ORDER BY seq DESC LIMIT 1',
      );
      const prev = head.rows[0]?.hash ?? AUDIT_GENESIS;
      const chained = chainEntry(e, prev);
      await client.query(
        `INSERT INTO audit (id, at, actor, action, campaign_id, detail, prev_hash, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          chained.id,
          chained.at,
          chained.actor,
          chained.action,
          chained.campaignId ?? null,
          chained.detail ?? null,
          chained.prevHash ?? null,
          chained.hash ?? null,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listAudit(limit = 200): Promise<AuditEntry[]> {
    const r = await this.pool.query(
      `SELECT id, at, actor, action, campaign_id AS "campaignId", detail, prev_hash AS "prevHash", hash
       FROM audit ORDER BY seq DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map(rowToAudit);
  }

  async listAuditChain(): Promise<AuditEntry[]> {
    const r = await this.pool.query(
      `SELECT id, at, actor, action, campaign_id AS "campaignId", detail, prev_hash AS "prevHash", hash
       FROM audit ORDER BY seq ASC`,
    );
    return r.rows.map(rowToAudit);
  }

  async listUsers(): Promise<User[]> {
    const r = await this.pool.query<{ email: string; role: string; password_hash: string }>(
      'SELECT email, role, password_hash FROM users ORDER BY email',
    );
    return r.rows
      .filter((x) => isRole(x.role))
      .map((x) => ({
        email: x.email,
        role: x.role as User['role'],
        passwordHash: x.password_hash,
      }));
  }

  async getUser(email: string): Promise<User | undefined> {
    const r = await this.pool.query<{ email: string; role: string; password_hash: string }>(
      'SELECT email, role, password_hash FROM users WHERE email=$1',
      [email.toLowerCase()],
    );
    const x = r.rows[0];
    if (!x || !isRole(x.role)) return undefined;
    return { email: x.email, role: x.role as User['role'], passwordHash: x.password_hash };
  }

  async saveUser(u: User): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (email, role, password_hash) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET role=$2, password_hash=$3`,
      [u.email.toLowerCase(), u.role, u.passwordHash],
    );
  }

  async deleteUser(email: string): Promise<void> {
    await this.pool.query('DELETE FROM users WHERE email=$1', [email.toLowerCase()]);
  }

  async listPlaybooks(): Promise<Playbook[]> {
    const r = await this.pool.query<{ data: Playbook }>('SELECT data FROM playbooks ORDER BY name');
    return r.rows.map((x) => x.data);
  }

  async getPlaybook(id: string): Promise<Playbook | undefined> {
    const r = await this.pool.query<{ data: Playbook }>('SELECT data FROM playbooks WHERE id=$1', [
      id,
    ]);
    return r.rows[0]?.data;
  }

  async savePlaybook(p: Playbook): Promise<void> {
    await this.pool.query(
      `INSERT INTO playbooks (id, name, data) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET name=$2, data=$3`,
      [p.id, p.name, JSON.stringify(p)],
    );
  }

  async deletePlaybook(id: string): Promise<void> {
    await this.pool.query('DELETE FROM playbooks WHERE id=$1', [id]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
