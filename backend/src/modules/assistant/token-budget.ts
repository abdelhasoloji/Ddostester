import { createHash } from 'node:crypto';
import type pg from 'pg';

export interface TokenReservation {
  schemaVersion: 'ddostester.assistant.budget/v1';
  reservedUnits: number;
  window: string;
  persistence: 'postgres' | 'process';
  accounting: 'utf8-input-bytes-plus-output-cap';
  providerTokens: null;
  cost: null;
}
export interface AssistantTokenBudget {
  reserve(identity: string, units: number): Promise<TokenReservation | undefined>;
}
const DAILY_USER = 50_000;
const DAILY_GLOBAL = 250_000;
function reservation(
  units: number,
  window: string,
  persistence: TokenReservation['persistence'],
): TokenReservation {
  return {
    schemaVersion: 'ddostester.assistant.budget/v1',
    reservedUnits: units,
    window,
    persistence,
    accounting: 'utf8-input-bytes-plus-output-cap',
    providerTokens: null,
    cost: null,
  };
}
function validate(units: number): void {
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error('Invalid assistant reservation');
}
export class ProcessTokenBudget implements AssistantTokenBudget {
  private window = '';
  private used = new Map<string, number>();
  private global = 0;
  async reserve(identity: string, units: number): Promise<TokenReservation | undefined> {
    validate(units);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.window) {
      this.window = day;
      this.used.clear();
      this.global = 0;
    }
    const previous = this.used.get(identity) ?? 0;
    if (
      previous + units > DAILY_USER ||
      this.global + units > DAILY_GLOBAL ||
      (!this.used.has(identity) && this.used.size >= 1000)
    )
      return undefined;
    this.used.set(identity, previous + units);
    this.global += units;
    return reservation(units, day, 'process');
  }
}
export class PostgresTokenBudget implements AssistantTokenBudget {
  constructor(private pool: pg.Pool) {}
  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS assistant_token_budget_v1 (
      budget_day date NOT NULL, identity text NOT NULL, units bigint NOT NULL CHECK (units >= 0),
      PRIMARY KEY (budget_day, identity))`);
    await this.prune();
  }
  async prune(): Promise<void> {
    // Expired admission counters are operational accounting, not the audit chain.
    await this.pool.query(`DELETE FROM assistant_token_budget_v1
      WHERE budget_day < (now() AT TIME ZONE 'UTC')::date - 90`);
  }
  async reserve(identity: string, units: number): Promise<TokenReservation | undefined> {
    validate(units);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(714212)');
      const day = (
        await client.query<{ day: string }>(
          "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day",
        )
      ).rows[0].day;
      const key = createHash('sha256').update(identity).digest('hex');
      for (const [id, cap] of [
        ['global', DAILY_GLOBAL],
        [key, DAILY_USER],
      ] as const) {
        const result = await client.query<{ units: string }>(
          `INSERT INTO assistant_token_budget_v1
          (budget_day, identity, units) VALUES ($1, $2, $3)
          ON CONFLICT (budget_day, identity) DO UPDATE SET units=assistant_token_budget_v1.units + EXCLUDED.units
          RETURNING units`,
          [day, id, units],
        );
        if (Number(result.rows[0].units) > cap) {
          await client.query('ROLLBACK');
          return undefined;
        }
      }
      await client.query('COMMIT');
      return reservation(units, day, 'postgres');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
