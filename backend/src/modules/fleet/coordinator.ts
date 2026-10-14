import { validateFleetProgress, type FleetProgress } from './progress.js';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { IoTProfile } from '../../engine/iot-profile.js';
import { FLEET_LIMITS, type HardCaps } from '../../config/limits.js';
import {
  assignmentHash,
  splitBudget,
  validateAssignment,
  type FleetAssignment,
} from './contract.js';

/** Durable lab coordination. No reassignment after loss: uncertainty cannot multiply a budget. */
export class FleetCoordinator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now = Date.now,
  ) {}
  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS fleet_runs_v1 (
      run_id text PRIMARY KEY, campaign_id text NOT NULL, deadline bigint NOT NULL,
      state text NOT NULL CHECK (state IN ('RUNNING','STOPPING','SETTLED')));
      CREATE TABLE IF NOT EXISTS fleet_shards_v1 (
      run_id text NOT NULL REFERENCES fleet_runs_v1(run_id), agent_id text NOT NULL,
      assignment jsonb NOT NULL, state text NOT NULL CHECK (state IN ('PENDING','RUNNING','SUCCEEDED','STOPPED','FAILED','LOST')),
      sequence bigint NOT NULL DEFAULT 0, final_result jsonb,
      PRIMARY KEY(run_id, agent_id));
      ALTER TABLE fleet_shards_v1 ADD COLUMN IF NOT EXISTS progress jsonb;
      ALTER TABLE fleet_shards_v1 ADD COLUMN IF NOT EXISTS progress_at bigint;
      ALTER TABLE fleet_runs_v1 ADD COLUMN IF NOT EXISTS control_lease_until bigint NOT NULL DEFAULT 0;
      ALTER TABLE fleet_runs_v1 ADD COLUMN IF NOT EXISTS expected_agents integer
        CHECK (expected_agents BETWEEN 1 AND 3);`);
  }
  async plan(
    input: {
      runId: string;
      campaignId: string;
      agentIds: string[];
      target: string;
      maxRps: number;
      concurrency: number;
      durationSec: number;
      iotProfile?: Omit<IoTProfile, 'deviceIndex'>;
      probeUrl?: string;
    },
    policy: { allowedHosts: string[]; allowedPorts: number[]; caps: HardCaps },
  ): Promise<void> {
    if (new Set(input.agentIds).size !== input.agentIds.length) throw new Error('Duplicate agents');
    const budgets = splitBudget(input.maxRps, input.concurrency, input.agentIds.length);
    const now = this.now();
    const deadline = now + input.durationSec * 1000;
    const assignments = input.agentIds.map((agentId, i) => {
      const data = {
        schema: input.iotProfile
          ? ('ddostester.fleet.assignment/v2' as const)
          : ('ddostester.fleet.assignment/v1' as const),
        ...(input.iotProfile
          ? { iotProfile: { ...input.iotProfile, deviceIndex: i }, probeUrl: input.probeUrl }
          : {}),
        campaignId: input.campaignId,
        runId: input.runId,
        agentId,
        attemptId: randomUUID(),
        target: input.target,
        ...budgets[i],
        durationSec: input.durationSec,
        notBefore: now,
        deadline,
        leaseUntil: Math.min(deadline, now + FLEET_LIMITS.leaseMs),
      };
      return validateAssignment(
        { ...data, configHash: assignmentHash(data) },
        { ...policy, agentId, now },
      );
    });
    // Check the parent's envelope, not just the divided shards.
    if (input.maxRps > policy.caps.maxRps || input.concurrency > policy.caps.maxConcurrency)
      throw new Error('Aggregate budget exceeds policy');
    await this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [FLEET_LIMITS.coordinationLock]);
      const active = await c.query(
        'SELECT run_id FROM fleet_runs_v1 WHERE deadline + $1 > $2 LIMIT 1',
        [FLEET_LIMITS.stopGraceMs, this.now()],
      );
      if (active.rows.length)
        throw new Error(
          'A fleet envelope is still reserved; wait for its deadline and closure margin',
        );
      await c.query(
        'INSERT INTO fleet_runs_v1(run_id,campaign_id,deadline,state,control_lease_until,expected_agents) VALUES($1,$2,$3,$4,$5,$6)',
        [
          input.runId,
          input.campaignId,
          deadline,
          'RUNNING',
          Math.min(deadline, now + FLEET_LIMITS.leaseMs),
          assignments.length,
        ],
      );
      for (const assignment of assignments)
        await c.query(
          'INSERT INTO fleet_shards_v1(run_id,agent_id,assignment,state) VALUES($1,$2,$3,$4)',
          [input.runId, assignment.agentId, JSON.stringify(assignment), 'PENDING'],
        );
    });
  }
  async claim(runId: string, agentId: string): Promise<FleetAssignment | null> {
    return this.tx(async (c) => {
      const run = await c.query('SELECT * FROM fleet_runs_v1 WHERE run_id=$1 FOR UPDATE', [runId]);
      if (
        !run.rows[0] ||
        run.rows[0].state !== 'RUNNING' ||
        Number(run.rows[0].deadline) <= this.now() ||
        Number(run.rows[0].control_lease_until) <= this.now()
      )
        return null;
      const row = await c.query(
        'SELECT * FROM fleet_shards_v1 WHERE run_id=$1 AND agent_id=$2 FOR UPDATE',
        [runId, agentId],
      );
      if (!row.rows[0] || row.rows[0].state !== 'PENDING') return null;
      const { configHash: _hash, ...data } = row.rows[0].assignment as FleetAssignment;
      void _hash;
      data.leaseUntil = Math.min(
        data.deadline,
        Number(run.rows[0].control_lease_until),
        this.now() + FLEET_LIMITS.leaseMs,
      );
      const assignment = { ...data, configHash: assignmentHash(data) };
      await c.query(
        "UPDATE fleet_shards_v1 SET state='RUNNING',assignment=$3 WHERE run_id=$1 AND agent_id=$2",
        [runId, agentId, JSON.stringify(assignment)],
      );
      return assignment;
    });
  }
  async heartbeat(
    runId: string,
    agentId: string,
    attemptId: string,
    sequence: number,
    progress?: FleetProgress,
  ): Promise<{ leaseUntil: number } | null> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid sequence');
    return this.tx(async (c) => {
      const run = await c.query('SELECT * FROM fleet_runs_v1 WHERE run_id=$1 FOR UPDATE', [runId]);
      const result = await c.query(
        'SELECT * FROM fleet_shards_v1 WHERE run_id=$1 AND agent_id=$2 FOR UPDATE',
        [runId, agentId],
      );
      const row = result.rows[0];
      if (
        !row ||
        !run.rows[0] ||
        run.rows[0].state !== 'RUNNING' ||
        Number(run.rows[0].control_lease_until) <= this.now() ||
        row.state !== 'RUNNING' ||
        row.assignment.attemptId !== attemptId ||
        Number(row.sequence) >= sequence ||
        row.assignment.leaseUntil <= this.now() ||
        row.assignment.deadline <= this.now()
      )
        return null;
      if (progress) {
        const checked = validateFleetProgress(progress, row.progress ?? undefined);
        await c.query(
          'UPDATE fleet_shards_v1 SET progress=$3,progress_at=$4 WHERE run_id=$1 AND agent_id=$2',
          [runId, agentId, JSON.stringify(checked), this.now()],
        );
      }
      const leaseUntil = Math.min(
        row.assignment.deadline,
        Number(run.rows[0].control_lease_until),
        this.now() + FLEET_LIMITS.leaseMs,
      );
      const { configHash: _hash, ...data } = row.assignment as FleetAssignment;
      void _hash;
      data.leaseUntil = leaseUntil;
      await c.query(
        'UPDATE fleet_shards_v1 SET sequence=$3,assignment=$4 WHERE run_id=$1 AND agent_id=$2',
        [runId, agentId, sequence, JSON.stringify({ ...data, configHash: assignmentHash(data) })],
      );
      return { leaseUntil };
    });
  }
  async reconcile(): Promise<number> {
    return this.tx(async (client) => {
      const result = await client.query(
        "UPDATE fleet_runs_v1 SET state='STOPPING' WHERE state='RUNNING' RETURNING run_id",
      );
      await client.query(
        "UPDATE fleet_shards_v1 SET state='STOPPED' WHERE state='PENDING' AND run_id IN (SELECT run_id FROM fleet_runs_v1 WHERE state='STOPPING')",
      );
      return result.rows.length;
    });
  }
  async renewControl(runId: string): Promise<boolean> {
    const now = this.now();
    const result = await this.pool.query(
      "UPDATE fleet_runs_v1 SET control_lease_until=LEAST(deadline,$2) WHERE run_id=$1 AND state='RUNNING' AND control_lease_until>$3 AND deadline>$3 RETURNING run_id",
      [runId, now + FLEET_LIMITS.leaseMs, now],
    );
    return result.rows.length === 1;
  }
  async stop(runId: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query(
        "UPDATE fleet_runs_v1 SET state='STOPPING' WHERE run_id=$1 AND state='RUNNING'",
        [runId],
      );
      await c.query(
        "UPDATE fleet_shards_v1 SET state='STOPPED' WHERE run_id=$1 AND state='PENDING'",
        [runId],
      );
    });
  }
  async finish(
    runId: string,
    agentId: string,
    attemptId: string,
    state: 'SUCCEEDED' | 'STOPPED' | 'FAILED',
    result: Record<string, unknown>,
  ): Promise<boolean> {
    if (
      !['SUCCEEDED', 'STOPPED', 'FAILED'].includes(state) ||
      Buffer.byteLength(JSON.stringify(result)) > FLEET_LIMITS.maxMessageBytes
    )
      throw new Error('Invalid final result');
    return this.tx(async (c) => {
      await c.query('SELECT run_id FROM fleet_runs_v1 WHERE run_id=$1 FOR UPDATE', [runId]);
      const found = await c.query(
        'SELECT * FROM fleet_shards_v1 WHERE run_id=$1 AND agent_id=$2 FOR UPDATE',
        [runId, agentId],
      );
      const row = found.rows[0];
      if (!row || row.assignment.attemptId !== attemptId) return false;
      if (row.final_result)
        return row.state === state && isDeepStrictEqual(row.final_result, result);
      if (row.state !== 'RUNNING') return false;
      await c.query(
        'UPDATE fleet_shards_v1 SET state=$3,final_result=$4 WHERE run_id=$1 AND agent_id=$2',
        [runId, agentId, state, JSON.stringify(result)],
      );
      return true;
    });
  }
  async snapshot(runId: string): Promise<{
    state: string;
    shards: {
      agentId: string;
      state: string;
      attemptId: string;
      leaseUntil: number;
      assignmentHash: string;
      budget: { maxRps: number; concurrency: number; durationSec: number };
      result?: Record<string, unknown>;
      progress?: FleetProgress;
      progressAt?: number;
    }[];
  } | null> {
    return this.tx(async (c) => {
      const run = await c.query('SELECT * FROM fleet_runs_v1 WHERE run_id=$1 FOR UPDATE', [runId]);
      if (!run.rows[0]) return null;
      // Lost is terminal; expiry is never a licence to start another attempt.
      await c.query(
        "UPDATE fleet_shards_v1 SET state='LOST' WHERE run_id=$1 AND state='RUNNING' AND (assignment->>'leaseUntil')::bigint <= $2",
        [runId, this.now()],
      );
      await c.query(
        "UPDATE fleet_shards_v1 SET state='LOST' WHERE run_id=$1 AND state='PENDING' AND (assignment->>'deadline')::bigint <= $2",
        [runId, this.now()],
      );
      const rows = await c.query(
        'SELECT * FROM fleet_shards_v1 WHERE run_id=$1 ORDER BY agent_id',
        [runId],
      );
      const shards = rows.rows.map((row) => ({
        agentId: row.agent_id as string,
        state: row.state as string,
        attemptId: row.assignment.attemptId as string,
        leaseUntil: row.assignment.leaseUntil as number,
        assignmentHash: row.assignment.configHash as string,
        budget: {
          maxRps: row.assignment.maxRps as number,
          concurrency: row.assignment.concurrency as number,
          durationSec: row.assignment.durationSec as number,
        },
        result: row.final_result as Record<string, unknown> | undefined,
        progress: row.progress as FleetProgress | undefined,
        progressAt: row.progress_at ? Number(row.progress_at) : undefined,
      }));
      if (shards.every((s) => !['PENDING', 'RUNNING'].includes(s.state))) {
        await c.query("UPDATE fleet_runs_v1 SET state='SETTLED' WHERE run_id=$1", [runId]);
        return { state: 'SETTLED', shards };
      }
      return { state: run.rows[0].state as string, shards };
    });
  }
  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
