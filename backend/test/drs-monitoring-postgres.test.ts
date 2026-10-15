import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { FleetCoordinator } from '../src/modules/fleet/coordinator.js';
import { collectFleetMonitoring } from '../src/modules/metrics/drs-detail.js';
const url = process.env.DATABASE_URL_TEST;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !url) throw Error('DATABASE_URL_TEST required');
(url ? describe : describe.skip)('DRS monitoring PostgreSQL read-only contract', () => {
  const schema = 'drs_metrics_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema });
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await new FleetCoordinator(pool).init();
    await pool.query(
      'CREATE TABLE fleet_missions_v1(id text PRIMARY KEY,epoch text NOT NULL,data jsonb NOT NULL)',
    );
    await pool.query(
      "INSERT INTO fleet_runs_v1(run_id,campaign_id,deadline,state,control_lease_until,expected_agents) VALUES('one','campaign',20000,'RUNNING',16000,3)",
    );
    await pool.query("INSERT INTO fleet_missions_v1 VALUES('one','epoch',$1)", [
      JSON.stringify({
        campaignId: 'campaign',
        drsRevisionId: 'revision',
        drsMode: 'synthetic-lab',
        createdAt: '2026-10-15T00:00:00Z',
      }),
    ]);
    for (const agent of ['a', 'b', 'c'])
      await pool.query(
        "INSERT INTO fleet_shards_v1(run_id,agent_id,assignment,state,progress_at) VALUES('one',$1,$2,'RUNNING',9000)",
        [agent, JSON.stringify({ leaseUntil: 16000 })],
      );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  it('runs in a server-enforced read-only transaction without expiring or settling shards', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const text = await collectFleetMonitoring(client, 10000);
      expect(text).toMatch(/agents_reporting\{[^\n]+\} 3/);
      const expired = await collectFleetMonitoring(client, 25000);
      expect(expired).toMatch(/agents_unknown\{[^\n]+\} 3/);
      expect((await client.query('SELECT DISTINCT state FROM fleet_shards_v1')).rows).toEqual([
        { state: 'RUNNING' },
      ]);
      expect((await client.query('SELECT state FROM fleet_runs_v1')).rows[0].state).toBe('RUNNING');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
  it('does not hide a bound mission whose coordinator record is missing', async () => {
    await pool.query("INSERT INTO fleet_missions_v1 VALUES('orphan','epoch',$1)", [
      JSON.stringify({
        campaignId: 'orphan',
        drsRevisionId: 'revision-orphan',
        drsMode: 'synthetic-lab',
        createdAt: '2026-10-15T01:00:00Z',
      }),
    ]);
    const text = await collectFleetMonitoring(pool, 10000);
    expect(text).toMatch(/coverage_complete\{campaign_id="orphan"[^\n]+\} 0/);
    expect(text).not.toMatch(/agents_reporting\{campaign_id="orphan"/);
  });
});
