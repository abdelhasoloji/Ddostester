import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ProcessTokenBudget, PostgresTokenBudget } from '../src/modules/assistant/token-budget.js';

it('caps per-identity admission without claiming provider usage or cost', async () => {
  const budget = new ProcessTokenBudget();
  const accepted = await budget.reserve('owner', 40_000);
  expect(accepted).toMatchObject({
    reservedUnits: 40_000,
    providerTokens: null,
    cost: null,
    persistence: 'process',
  });
  expect(await budget.reserve('owner', 10_001)).toBeUndefined();
  expect(await budget.reserve('owner', 10_000)).toBeDefined();
  await expect(budget.reserve('owner', -1)).rejects.toThrow('Invalid');
});

it('caps global admission across identities', async () => {
  const budget = new ProcessTokenBudget();
  for (let i = 0; i < 5; i++) expect(await budget.reserve(`identity-${i}`, 50_000)).toBeDefined();
  expect(await budget.reserve('sixth', 1)).toBeUndefined();
});

it.skipIf(!process.env.DATABASE_URL_TEST)(
  'persists concurrent reservations and rolls back rejected global charges',
  async () => {
    const source = process.env.DATABASE_URL_TEST!;
    const admin = new pg.Pool({ connectionString: source });
    const name = 'assistant_budget_' + randomUUID().replaceAll('-', '');
    const url = new URL(source);
    url.pathname = '/' + name;
    await admin.query(`CREATE DATABASE "${name}"`);
    const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    const budget = new PostgresTokenBudget(pool);
    try {
      await budget.init();
      const attempts = await Promise.all(
        Array.from({ length: 20 }, () => budget.reserve('owner', 4000)),
      );
      expect(attempts.filter(Boolean)).toHaveLength(12);
      const restarted = new PostgresTokenBudget(pool);
      expect(await restarted.reserve('owner', 2001)).toBeUndefined();
      expect(await restarted.reserve('owner', 2000)).toMatchObject({
        persistence: 'postgres',
        reservedUnits: 2000,
      });
      const total = await pool.query(
        "SELECT units FROM assistant_token_budget_v1 WHERE identity='global'",
      );
      expect(Number(total.rows[0].units)).toBe(50_000);
      await pool.query(`INSERT INTO assistant_token_budget_v1 (budget_day, identity, units)
      VALUES ((now() AT TIME ZONE 'UTC')::date - 91, 'expired', 123)`);
      await restarted.init();
      expect(
        (await pool.query("SELECT units FROM assistant_token_budget_v1 WHERE identity='expired'"))
          .rowCount,
      ).toBe(0);
      expect(
        Number(
          (await pool.query("SELECT units FROM assistant_token_budget_v1 WHERE identity='global'"))
            .rows[0].units,
        ),
      ).toBe(50_000);
      const identities = await pool.query('SELECT identity FROM assistant_token_budget_v1');
      expect(identities.rows.map((row) => row.identity)).not.toContain('owner');
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
