import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FleetCoordinator } from '../src/modules/fleet/coordinator.js';
import { inspectFleet } from '../src/modules/fleet/status.js';
import {
  persistedFleetEvidence,
  persistedFleetEvidenceFromEnv,
} from '../src/modules/fleet/persisted-evidence.js';
import { createHash } from 'node:crypto';
const url = process.env.DATABASE_URL_TEST;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !url)
  throw new Error('DATABASE_URL_TEST required');
(url ? describe : describe.skip)('durable fleet coordination', () => {
  const pool = new pg.Pool({ connectionString: url });
  let now = Date.now();
  const created: string[] = [];
  const coordinator = new FleetCoordinator(pool, () => now);
  const policy = {
    allowedHosts: ['target.test'],
    allowedPorts: [8080],
    caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
  };
  const plan = async () => {
    now += 60000;
    const runId = randomUUID();
    await coordinator.plan(
      {
        runId,
        campaignId: randomUUID(),
        agentIds: ['one', 'two', 'three'],
        target: 'http://target.test:8080/',
        maxRps: 15,
        concurrency: 6,
        durationSec: 30,
      },
      policy,
    );
    created.push(runId);
    return runId;
  };
  beforeAll(() => coordinator.init());
  afterAll(async () => {
    for (const runId of created) {
      await pool.query('DELETE FROM fleet_shards_v1 WHERE run_id=$1', [runId]);
      await pool.query('DELETE FROM fleet_runs_v1 WHERE run_id=$1', [runId]);
    }
    await pool.end();
  });
  it('claims once under concurrency, fences replay, and survives a coordinator restart', async () => {
    const run = await plan();
    const claims = await Promise.all([
      coordinator.claim(run, 'one'),
      coordinator.claim(run, 'one'),
    ]);
    const assignment = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    const evidence = (await coordinator.snapshot(run))!.shards;
    expect(evidence.reduce((total, shard) => total + shard.budget.maxRps, 0)).toBe(15);
    expect(evidence.reduce((total, shard) => total + shard.budget.concurrency, 0)).toBe(6);
    expect(evidence.find((shard) => shard.agentId === 'one')!.assignmentHash).toBe(
      assignment.configHash,
    );
    expect(await coordinator.heartbeat(run, 'one', 'wrong', 1)).toBeNull();
    expect(await coordinator.heartbeat(run, 'one', assignment.attemptId, 1)).not.toBeNull();
    expect(await coordinator.heartbeat(run, 'one', assignment.attemptId, 1)).toBeNull();
    const restarted = new FleetCoordinator(pool, () => now);
    expect(await restarted.claim(run, 'one')).toBeNull();
    await restarted.stop(run);
    expect(await restarted.heartbeat(run, 'one', assignment.attemptId, 2)).toBeNull();
    expect(await restarted.claim(run, 'two')).toBeNull();
    expect(
      await restarted.finish(run, 'one', assignment.attemptId, 'STOPPED', {
        socketsClosed: true,
        total: 0,
      }),
    ).toBe(true);
    expect(
      await restarted.finish(run, 'one', assignment.attemptId, 'STOPPED', {
        total: 0,
        socketsClosed: true,
      }),
    ).toBe(true);
    expect((await restarted.snapshot(run))?.state).toBe('SETTLED');
  });
  it('exports interrupted durable evidence without recreating probe data or mutating leases', async () => {
    const run = await plan();
    await coordinator.claim(run, 'one');
    await pool.query("UPDATE fleet_runs_v1 SET state='STOPPING' WHERE run_id=$1", [run]);
    const before = await pool.query(
      'SELECT state,control_lease_until FROM fleet_runs_v1 WHERE run_id=$1',
      [run],
    );
    const evidence = (await persistedFleetEvidence(pool, run))!;
    expect(evidence.content.state).toBe('STOPPING');
    expect(evidence.content.counterCoverage).toMatchObject({
      reportedAgents: 0,
      expectedAgents: 3,
    });
    expect(evidence.content).toMatchObject({
      probe: null,
      wrs: null,
      targetReceipts: null,
      isFinalizedCampaignReport: false,
    });
    expect(JSON.stringify(evidence)).not.toContain('target.test');
    const discovered = await persistedFleetEvidenceFromEnv(
      '',
      { FLEET_ENABLED: '1', DATABASE_URL: url },
      evidence.content.campaignId,
    );
    expect(discovered?.content.runId).toBe(run);
    expect(evidence.sha256).toBe(
      createHash('sha256').update(JSON.stringify(evidence.content)).digest('hex'),
    );
    expect(
      (
        await pool.query('SELECT state,control_lease_until FROM fleet_runs_v1 WHERE run_id=$1', [
          run,
        ])
      ).rows,
    ).toEqual(before.rows);
    expect(await persistedFleetEvidence(pool, 'unknown-run')).toBeUndefined();
    await pool.query(
      "UPDATE fleet_shards_v1 SET state='STOPPED',final_result=$2::jsonb WHERE run_id=$1 AND agent_id='one'",
      [
        run,
        JSON.stringify({
          state: 'STOPPED',
          podIp: '10.247.0.1',
          generator: {
            totalRequests: 2,
            successful: 2,
            failed: 0,
            config: { headers: { authorization: 'canary-secret' } },
            unexpected: 'canary-secret',
          },
          resources: {
            schema: 'ddostester.fleet.resources/v1',
            elapsedMs: 5,
            processCpuUserUsec: 'canary-secret',
            unexpected: 'canary-secret',
          },
        }),
      ],
    );
    const received = (await persistedFleetEvidence(pool, run))!;
    expect(received.content.counterCoverage.reportedAgents).toBe(1);
    expect(received.content.shards[0].result?.generator?.totalRequests).toBe(2);
    expect(received.content.shards[0].result?.resources?.processCpuUserUsec).toBeNull();
    expect(JSON.stringify(received)).not.toContain('canary-secret');
  });
  it('preserves planned coverage when a shard row is missing and leaves legacy plans unknown', async () => {
    const run = await plan();
    await pool.query("DELETE FROM fleet_shards_v1 WHERE run_id=$1 AND agent_id='three'", [run]);
    const evidence = (await persistedFleetEvidence(pool, run))!;
    expect(evidence.content.shards).toHaveLength(2);
    expect(evidence.content.counterCoverage.expectedAgents).toBe(3);
    await pool.query('UPDATE fleet_runs_v1 SET expected_agents=NULL WHERE run_id=$1', [run]);
    expect(
      (await persistedFleetEvidence(pool, run))!.content.counterCoverage.expectedAgents,
    ).toBeNull();
  });
  it('never reassigns a lost budget, even after expiry and restart', async () => {
    const run = await plan();
    const assignment = await coordinator.claim(run, 'one');
    now += 6001;
    const observation = await inspectFleet(pool, now);
    expect(observation.agents.find((agent) => agent.agentId === 'one')).toMatchObject({
      state: 'RUNNING',
      leaseExpired: true,
    });
    expect(
      (
        await pool.query('SELECT state FROM fleet_shards_v1 WHERE run_id=$1 AND agent_id=$2', [
          run,
          'one',
        ])
      ).rows[0].state,
    ).toBe('RUNNING');
    expect(await coordinator.heartbeat(run, 'one', assignment!.attemptId, 1)).toBeNull();
    expect((await coordinator.snapshot(run))?.shards.find((x) => x.agentId === 'one')?.state).toBe(
      'LOST',
    );
    expect(await coordinator.claim(run, 'one')).toBeNull();
    now += 30000;
    expect((await coordinator.snapshot(run))?.state).toBe('SETTLED');
  });
  it('stops renewing agent leases when the parent control plane disappears', async () => {
    const run = await plan();
    const assignment = await coordinator.claim(run, 'one');
    now += 2000;
    const renewal = await coordinator.heartbeat(run, 'one', assignment!.attemptId, 1);
    expect(renewal!.leaseUntil).toBe(assignment!.leaseUntil);
    now += 4001;
    expect(await coordinator.heartbeat(run, 'one', assignment!.attemptId, 2)).toBeNull();
    expect(await coordinator.renewControl(run)).toBe(false);
    expect(await coordinator.claim(run, 'two')).toBeNull();
  });
  it('rejects aggregate policy overflow before persisting shards', async () => {
    await expect(
      coordinator.plan(
        {
          runId: randomUUID(),
          campaignId: randomUUID(),
          agentIds: ['one', 'two', 'three'],
          target: 'http://target.test:8080/',
          maxRps: 18,
          concurrency: 6,
          durationSec: 30,
        },
        policy,
      ),
    ).rejects.toThrow(/Aggregate/);
  });
  it('does not grant a lease, receipt or reservation for an unknown durable run', async () => {
    const missing = randomUUID();
    expect(await coordinator.snapshot(missing)).toBeNull();
    expect(await coordinator.claim(missing, 'one')).toBeNull();
    expect(await coordinator.renewControl(missing)).toBe(false);
    expect(await coordinator.heartbeat(missing, 'one', 'missing-attempt', 1)).toBeNull();
    expect(await coordinator.finish(missing, 'one', 'missing-attempt', 'SUCCEEDED', {})).toBe(
      false,
    );
    await coordinator.stop(missing);
    expect(await coordinator.snapshot(missing)).toBeNull();
    await expect(
      coordinator.plan(
        {
          runId: missing,
          campaignId: randomUUID(),
          agentIds: ['one', 'one'],
          target: 'http://target.test:8080/',
          maxRps: 3,
          concurrency: 3,
          durationSec: 10,
        },
        policy,
      ),
    ).rejects.toThrow('Duplicate agents');
  });
  it('records certificate presence and reports its health', async () => {
    const at = now;
    const expiry = at + 3 * 86_400_000;
    await coordinator.recordPresence('one', 'vps-lab', expiry);
    expect((await coordinator.presence()).find((row) => row.agentId === 'one')).toMatchObject({
      site: 'vps-lab',
      certExpiresAt: expiry,
      lastSeen: at,
    });
    const status = await inspectFleet(pool, at);
    expect(status.certificates.find((row) => row.agentId === 'one')).toMatchObject({
      site: 'vps-lab',
      expiresAt: expiry,
      daysRemaining: 3,
      status: 'expiring',
    });
  });
  it('records the originating site with each shard', async () => {
    now += 60_000;
    const runId = randomUUID();
    await coordinator.plan(
      {
        runId,
        campaignId: randomUUID(),
        agentIds: ['one', 'two', 'three'],
        sites: [
          { agentId: 'one', site: 'vps-lab' },
          { agentId: 'two', site: 'vps-lab' },
          { agentId: 'three', site: 'ac02' },
        ],
        target: 'http://target.test:8080/',
        maxRps: 15,
        concurrency: 6,
        durationSec: 30,
      },
      policy,
    );
    created.push(runId);
    const snapshot = await coordinator.snapshot(runId);
    expect(
      Object.fromEntries((snapshot?.shards ?? []).map((shard) => [shard.agentId, shard.site])),
    ).toEqual({ one: 'vps-lab', two: 'vps-lab', three: 'ac02' });
    const status = await inspectFleet(pool, now);
    expect(status.agents.find((entry) => entry.agentId === 'three')?.site).toBe('ac02');
  });
  it('serves planned work to a worker that does not know the runId', async () => {
    now += 60_000;
    const runId = await plan();
    const assignment = await coordinator.claimNext('one');
    expect(assignment).toMatchObject({ runId, agentId: 'one' });
    // The shard is RUNNING now: a second poll must not hand out work twice.
    expect(await coordinator.claimNext('one')).toBeNull();
  });
});
