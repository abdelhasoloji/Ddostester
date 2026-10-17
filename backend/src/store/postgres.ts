import type { InfrastructureRevision } from '../modules/infrastructure/model.js';
import pg from 'pg';
import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
import { AUDIT_GENESIS, chainEntry } from '../modules/audit/integrity.js';
import type { User } from '../auth/users.js';
import type { Playbook } from '../modules/playbooks/playbooks.js';
import type { ProtectedTarget } from '../modules/targets/model.js';
import { withCanonicalRole } from '../auth/rbac.js';

/**
 * The campaigns/runs primary keys are Postgres `uuid`. A lookup with a non-UUID
 * id (a hand-typed or bogus path param) would make Postgres throw
 * "invalid input syntax for type uuid" → an unhelpful 500. A malformed id simply
 * cannot exist, so we treat it as "not found" and never hit the DB.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id: string): boolean => typeof id === 'string' && UUID_RE.test(id);
import type { OperationalLimits } from '../config/limits.js';
import type {
  BenchRun,
  BenchVerdict,
  BenchRunStatus,
  BenchCoverage,
  CoverageMethod,
} from '../modules/bench/model.js';
import type { Store, AccountPolicy, UserTransaction } from './types.js';
import type { FleetDevice } from '../modules/fleet/devices.js';

const { Pool } = pg;

/** Advisory-lock key serializing audit-chain appends (arbitrary constant). */
const AUDIT_LOCK_KEY = 4021;

interface UserRow {
  email: string;
  role: string;
  password_hash: string;
  status: string;
  must_change_password: boolean;
  last_login_at: Date | null;
  token_version: string | number | null;
  created_at: Date | null;
}

const USER_SELECT =
  'SELECT email, role, password_hash, status, must_change_password, last_login_at, ' +
  'token_version, created_at FROM users';

function rowToUser(x: UserRow): User {
  return {
    email: x.email,
    role: x.role as User['role'],
    passwordHash: x.password_hash,
    status: x.status === 'disabled' ? 'disabled' : 'active',
    mustChangePassword: x.must_change_password === true,
    lastLoginAt: x.last_login_at instanceof Date ? x.last_login_at.toISOString() : undefined,
    createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : undefined,
    tokenVersion: x.token_version != null ? Number(x.token_version) : 0,
  };
}

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
  {
    // CISO-managed operational limits, and any future singleton config: a small
    // key→jsonb settings table. The absolute HARD_CAPS ceiling is code-only and
    // is never stored here.
    id: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key        text PRIMARY KEY,
        data       jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // Governed class-C bench runs (record-and-dispatch). The control plane
    // records a request; an isolated external runner claims and completes it.
    // No amplification traffic is ever emitted from the control plane.
    id: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS bench_runs (
        id           text PRIMARY KEY,
        scenario     text NOT NULL,
        lab_target   text NOT NULL,
        status       text NOT NULL,
        requested_by text NOT NULL,
        requested_at timestamptz NOT NULL,
        claimed_at   timestamptz,
        claimed_by   text,
        completed_at timestamptz,
        verdict      jsonb,
        error        text
      );
      CREATE INDEX IF NOT EXISTS bench_runs_status_idx ON bench_runs (status, requested_at);
    `,
  },
  {
    // Coverage evidence for bench vectors (non-run methods): ingested external
    // verdicts, control attestations, modelled/replay judgements. Read-only
    // assurance; no traffic is ever emitted from the control plane.
    id: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS bench_coverage (
        id          text PRIMARY KEY,
        vector      text NOT NULL,
        method      text NOT NULL,
        outcome     text,
        drs         integer,
        summary     text NOT NULL,
        source      text NOT NULL,
        recorded_by text NOT NULL,
        at          timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bench_coverage_vector_idx ON bench_coverage (vector, at DESC);
    `,
  },
  {
    // Mature user management: account status (soft deactivation), forced
    // password change for admin-set temporary passwords, last-login tracking,
    // and a token-version counter used to revoke outstanding sessions.
    id: 6,
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS status               text NOT NULL DEFAULT 'active';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at        timestamptz;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version        integer NOT NULL DEFAULT 0;
    `,
  },
  {
    // Protected targets (governed onboarding). Metadata + authorization
    // lifecycle; only `authorized` rows extend the effective allowlist.
    id: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS targets (
        id          text PRIMARY KEY,
        host        text NOT NULL,
        auth_status text NOT NULL DEFAULT 'unauthorized',
        data        jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS targets_auth_status_idx ON targets (auth_status);
    `,
  },
  {
    id: 8,
    sql: `CREATE TABLE IF NOT EXISTS fleet_devices_v1 (id text PRIMARY KEY, data jsonb NOT NULL);`,
  },
  {
    id: 9,
    sql: `CREATE TABLE IF NOT EXISTS infrastructure_revisions_v1 (
      kind text NOT NULL CHECK (kind IN ('host','evidence')),
      id text NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      data jsonb NOT NULL,
      PRIMARY KEY (kind,id,revision)
    );`,
  },
  {
    id: 10,
    sql: `ALTER TABLE infrastructure_revisions_v1 DROP CONSTRAINT infrastructure_revisions_v1_kind_check;
      ALTER TABLE infrastructure_revisions_v1 ADD CONSTRAINT infrastructure_revisions_v1_kind_check CHECK (kind IN ('host','evidence','client'));`,
  },
];

/** settings key for the CISO-managed operational limits. */
const LIMITS_KEY = 'operational_limits';

/**
 * PostgreSQL persistence. Campaign / CampaignRun objects are stored as jsonb
 * (flexible), with a few dedicated columns for filtering and ordering (status,
 * target, WRS, dates) — the basis of a per-target WRS history (TSD §5.4).
 */
export class PostgresStore implements Store {
  async listInfrastructure(
    kind: InfrastructureRevision['kind'],
  ): Promise<InfrastructureRevision[]> {
    const r = await this.pool.query<{ data: InfrastructureRevision }>(
      'SELECT DISTINCT ON (id) data FROM infrastructure_revisions_v1 WHERE kind=$1 ORDER BY id,revision DESC',
      [kind],
    );
    return r.rows.map((x) => x.data);
  }
  async infrastructureHistory(
    kind: InfrastructureRevision['kind'],
    id: string,
  ): Promise<InfrastructureRevision[]> {
    const r = await this.pool.query<{ data: InfrastructureRevision }>(
      'SELECT data FROM infrastructure_revisions_v1 WHERE kind=$1 AND id=$2 ORDER BY revision',
      [kind, id],
    );
    return r.rows.map((x) => x.data);
  }
  async appendInfrastructure(record: InfrastructureRevision): Promise<void> {
    await this.pool.query(
      'INSERT INTO infrastructure_revisions_v1(kind,id,revision,data) VALUES($1,$2,$3,$4)',
      [record.kind, record.id, record.revision, JSON.stringify(record)],
    );
  }
  async getFleetDevice(id: string): Promise<FleetDevice | undefined> {
    const r = await this.pool.query<{ data: FleetDevice }>(
      'SELECT data FROM fleet_devices_v1 WHERE id=$1',
      [id],
    );
    return r.rows[0]?.data;
  }
  async listFleetDevices(): Promise<FleetDevice[]> {
    const result = await this.pool.query<{ data: FleetDevice }>(
      'SELECT data FROM fleet_devices_v1 ORDER BY id',
    );
    return result.rows.map((row) => row.data);
  }
  async saveFleetDevice(device: FleetDevice): Promise<void> {
    await this.pool.query(
      'INSERT INTO fleet_devices_v1(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=$2',
      [device.id, JSON.stringify(device)],
    );
  }
  async deleteFleetDevice(id: string): Promise<void> {
    await this.pool.query('DELETE FROM fleet_devices_v1 WHERE id=$1', [id]);
  }
  readonly backend = 'postgres' as const;
  private pool: pg.Pool;
  private transactionClient?: pg.PoolClient;
  private runtimeLease?: pg.PoolClient;

  /** true if the TimescaleDB extension is available (wrs_samples becomes a hypertable). */
  private timescale = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async acquireRuntimeLease(): Promise<boolean> {
    if (this.runtimeLease) return true;
    const client = await this.pool.connect();
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [714210],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return false;
    }
    // Losing the dedicated lease connection must stop the runtime, never continue unlocked.
    client.on('error', () => process.kill(process.pid, 'SIGTERM'));
    this.runtimeLease = client;
    return true;
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
    if (!isUuid(id)) return undefined; // malformed id → not found (never a 500)
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

  async deleteCampaigns(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    // Collect the run ids first so we can clean up the (non-FK) wrs_samples;
    // deleting campaigns cascades to `runs` (ON DELETE CASCADE), never to audit.
    const runIds = await this.pool.query<{ run_id: string }>(
      'SELECT run_id FROM runs WHERE campaign_id = ANY($1)',
      [ids],
    );
    const runIdList = runIds.rows.map((r) => r.run_id);
    if (runIdList.length > 0) {
      await this.pool.query('DELETE FROM wrs_samples WHERE run_id = ANY($1)', [runIdList]);
    }
    const del = await this.pool.query('DELETE FROM campaigns WHERE id = ANY($1)', [ids]);
    return del.rowCount ?? 0;
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
    if (!isUuid(runId)) return undefined; // malformed id → not found (never a 500)
    const r = await this.pool.query<{ data: CampaignRun }>(
      'SELECT data FROM runs WHERE run_id=$1',
      [runId],
    );
    return r.rows[0]?.data;
  }

  async listRuns(campaignId?: string): Promise<CampaignRun[]> {
    if (campaignId && !isUuid(campaignId)) return []; // malformed filter → no rows (never a 500)
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

  private async appendAudit(e: AuditEntry, client: Pick<pg.Pool, 'query'>): Promise<void> {
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
  }
  async saveAudit(e: AuditEntry): Promise<void> {
    if (this.transactionClient) return this.appendAudit(e, this.transactionClient);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.appendAudit(e, client);
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
    const r = await this.pool.query<UserRow>(`${USER_SELECT} ORDER BY email`);
    // Canonicalise each row's role (legacy `officer` → `admin`) and drop only
    // rows whose role maps to no current Role — a legacy user stays visible.
    return r.rows
      .map((x) => withCanonicalRole(rowToUser(x)))
      .filter((u): u is User => u !== undefined);
  }

  async getUser(email: string): Promise<User | undefined> {
    const r = await this.pool.query<UserRow>(`${USER_SELECT} WHERE email=$1`, [
      email.toLowerCase(),
    ]);
    const x = r.rows[0];
    if (!x) return undefined;
    // Canonicalise on read so a legacy `officer` row resolves to `admin` instead
    // of being dropped here (which locked the user out before login could map it).
    return withCanonicalRole(rowToUser(x));
  }

  async getAccountPolicy(): Promise<AccountPolicy | undefined> {
    const r = await this.pool.query<{ data: AccountPolicy }>(
      'SELECT data FROM settings WHERE key=$1',
      ['access-policy/v1'],
    );
    return r.rows[0]?.data;
  }
  async setAccountPolicy(policy: AccountPolicy): Promise<void> {
    await this.pool.query(
      'INSERT INTO settings(key,data,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET data=$2,updated_at=now()',
      ['access-policy/v1', JSON.stringify(policy)],
    );
  }
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.transactionClient) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [714209]);
      const tx = Object.create(this) as PostgresStore;
      tx.pool = client as unknown as pg.Pool;
      tx.transactionClient = client;
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  async transactionUsers<T>(fn: (tx: UserTransaction) => Promise<T>): Promise<T> {
    if (this.transactionClient) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [714209]);
      const tx: UserTransaction = {
        listUsers: async () =>
          (await client.query<UserRow>(`${USER_SELECT} ORDER BY email`)).rows
            .map((row) => withCanonicalRole(rowToUser(row)))
            .filter((u): u is User => !!u),
        getUser: async (email) => {
          const r = await client.query<UserRow>(`${USER_SELECT} WHERE email=$1`, [
            email.toLowerCase(),
          ]);
          return r.rows[0] ? withCanonicalRole(rowToUser(r.rows[0])) : undefined;
        },
        saveUser: (user) => this.upsertUser(user, client),
        deleteUser: async (email) => {
          await client.query('DELETE FROM users WHERE email=$1', [email.toLowerCase()]);
        },
        saveAudit: (entry) => this.appendAudit(entry, client),
        getAccountPolicy: async () =>
          (
            await client.query<{ data: AccountPolicy }>('SELECT data FROM settings WHERE key=$1', [
              'access-policy/v1',
            ])
          ).rows[0]?.data,
        setAccountPolicy: async (policy) => {
          await client.query(
            'INSERT INTO settings(key,data,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET data=$2,updated_at=now()',
            ['access-policy/v1', JSON.stringify(policy)],
          );
        },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async saveUser(u: User): Promise<void> {
    await this.upsertUser(u, this.pool);
  }

  async saveUsersAtomically(users: User[]): Promise<void> {
    if (this.transactionClient) {
      for (const user of users) await this.upsertUser(user, this.transactionClient);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of users) await this.upsertUser(u, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async upsertUser(u: User, db: Pick<pg.Pool, 'query'>): Promise<void> {
    await db.query(
      `INSERT INTO users
         (email, role, password_hash, status, must_change_password, last_login_at,
          token_version, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now()))
       ON CONFLICT (email) DO UPDATE SET
         role=$2, password_hash=$3, status=$4, must_change_password=$5,
         last_login_at=$6, token_version=$7`,
      [
        u.email.toLowerCase(),
        u.role,
        u.passwordHash,
        u.status ?? 'active',
        u.mustChangePassword ?? false,
        u.lastLoginAt ?? null,
        u.tokenVersion ?? 0,
        u.createdAt ?? null,
      ],
    );
  }

  async deleteUser(email: string): Promise<void> {
    await this.pool.query('DELETE FROM users WHERE email=$1', [email.toLowerCase()]);
  }

  async recordLogin(email: string, at: string): Promise<void> {
    await this.pool.query('UPDATE users SET last_login_at=$2 WHERE email=$1', [
      email.toLowerCase(),
      at,
    ]);
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

  async listTargets(): Promise<ProtectedTarget[]> {
    const r = await this.pool.query<{ data: ProtectedTarget }>(
      'SELECT data FROM targets ORDER BY host',
    );
    return r.rows.map((row) => row.data);
  }
  async getTarget(id: string): Promise<ProtectedTarget | undefined> {
    const r = await this.pool.query<{ data: ProtectedTarget }>(
      'SELECT data FROM targets WHERE id=$1',
      [id],
    );
    return r.rows[0]?.data;
  }
  async saveTarget(t: ProtectedTarget): Promise<void> {
    await this.pool.query(
      `INSERT INTO targets (id, host, auth_status, data, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (id) DO UPDATE SET host=$2, auth_status=$3, data=$4, updated_at=now()`,
      [t.id, t.host, t.authStatus, JSON.stringify(t)],
    );
  }
  async deleteTarget(id: string): Promise<void> {
    await this.pool.query('DELETE FROM targets WHERE id=$1', [id]);
  }

  async getLimits(): Promise<OperationalLimits | undefined> {
    const r = await this.pool.query<{ data: OperationalLimits }>(
      'SELECT data FROM settings WHERE key=$1',
      [LIMITS_KEY],
    );
    return r.rows[0]?.data;
  }

  async setLimits(limits: OperationalLimits): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET data=$2, updated_at=now()`,
      [LIMITS_KEY, JSON.stringify(limits)],
    );
  }

  async createBenchRun(run: BenchRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO bench_runs (id, scenario, lab_target, status, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [run.id, run.scenario, run.labTarget, run.status, run.requestedBy, run.requestedAt],
    );
  }

  async getBenchRun(id: string): Promise<BenchRun | undefined> {
    const r = await this.pool.query('SELECT * FROM bench_runs WHERE id=$1', [id]);
    return r.rows[0] ? rowToBenchRun(r.rows[0]) : undefined;
  }

  async listBenchRuns(limit = 100, activeOnly = false): Promise<BenchRun[]> {
    const r = await this.pool.query(
      `SELECT * FROM bench_runs ${activeOnly ? "WHERE status IN ('REQUESTED','CLAIMED')" : ''} ORDER BY requested_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map(rowToBenchRun);
  }

  async claimNextBenchRun(runnerId: string): Promise<BenchRun | undefined> {
    // Atomic claim: pick the oldest REQUESTED row, lock it, flip to CLAIMED.
    // SKIP LOCKED lets multiple runners claim distinct rows without blocking.
    const r = await this.pool.query(
      `UPDATE bench_runs SET status='CLAIMED', claimed_at=now(), claimed_by=$1
       WHERE id = (
         SELECT id FROM bench_runs WHERE status='REQUESTED'
         ORDER BY requested_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING *`,
      [runnerId],
    );
    return r.rows[0] ? rowToBenchRun(r.rows[0]) : undefined;
  }

  async setBenchRunResult(
    id: string,
    result: { verdict?: BenchVerdict; error?: string },
  ): Promise<BenchRun | undefined> {
    const status: BenchRunStatus = result.verdict ? 'COMPLETED' : 'FAILED';
    const r = await this.pool.query(
      `UPDATE bench_runs SET status=$2, completed_at=now(), verdict=$3, error=$4
       WHERE id=$1 RETURNING *`,
      [
        id,
        status,
        result.verdict ? JSON.stringify(result.verdict) : null,
        result.verdict ? null : (result.error ?? 'unknown error'),
      ],
    );
    return r.rows[0] ? rowToBenchRun(r.rows[0]) : undefined;
  }

  async saveBenchCoverage(c: BenchCoverage): Promise<void> {
    await this.pool.query(
      `INSERT INTO bench_coverage (id, vector, method, outcome, drs, summary, source, recorded_by, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        c.id,
        c.vector,
        c.method,
        c.outcome ?? null,
        c.drs ?? null,
        c.summary,
        c.source,
        c.recordedBy,
        c.at,
      ],
    );
  }

  async listBenchCoverage(): Promise<BenchCoverage[]> {
    const r = await this.pool.query('SELECT * FROM bench_coverage ORDER BY at DESC');
    return r.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      vector: String(row.vector),
      method: String(row.method) as CoverageMethod,
      outcome: row.outcome == null ? undefined : String(row.outcome),
      drs: row.drs == null ? undefined : Number(row.drs),
      summary: String(row.summary),
      source: String(row.source),
      recordedBy: String(row.recorded_by),
      at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    }));
  }

  async close(): Promise<void> {
    if (this.runtimeLease) {
      await this.runtimeLease.query('SELECT pg_advisory_unlock($1)', [714210]);
      this.runtimeLease.release();
      this.runtimeLease = undefined;
    }
    await this.pool.end();
  }
}

/** Maps a bench_runs row to a BenchRun (timestamps → ISO strings). */
function rowToBenchRun(row: Record<string, unknown>): BenchRun {
  const iso = (v: unknown): string | undefined =>
    v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined;
  return {
    id: String(row.id),
    scenario: String(row.scenario),
    labTarget: String(row.lab_target),
    status: String(row.status) as BenchRunStatus,
    requestedBy: String(row.requested_by),
    requestedAt: iso(row.requested_at) ?? new Date().toISOString(),
    claimedAt: iso(row.claimed_at),
    claimedBy: row.claimed_by == null ? undefined : String(row.claimed_by),
    completedAt: iso(row.completed_at),
    verdict: (row.verdict as BenchVerdict | null) ?? undefined,
    error: row.error == null ? undefined : String(row.error),
  };
}
