import pg from 'pg';
import { createHash } from 'node:crypto';
import { fleetMeasurements, fleetResourceMeasurements } from '../reports/fleet-evidence.js';
import type { LoadTestResult } from '../../engine/types.js';

/** Read-only evidence survives a control crash; absent probe/report data stays absent. */
export async function persistedFleetEvidence(pool: pg.Pool, runId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('Invalid fleet run identifier');
  const rows = (
    await pool.query(
      `SELECT r.run_id,r.campaign_id,r.state AS run_state,
    r.deadline,r.control_lease_until,r.expected_agents,s.agent_id,s.state,s.assignment,s.sequence,
    s.progress,s.progress_at,s.final_result FROM fleet_runs_v1 r
    LEFT JOIN fleet_shards_v1 s ON s.run_id=r.run_id WHERE r.run_id=$1
    ORDER BY s.agent_id LIMIT 3`,
      [runId],
    )
  ).rows;
  if (!rows.length) return undefined;
  const parent = rows[0];
  const shards = rows
    .filter((row) => row.agent_id)
    .map((row) => ({
      agentId: row.agent_id,
      state: row.state,
      sequence: Number(row.sequence),
      attemptId: row.assignment.attemptId,
      assignmentHash: row.assignment.configHash,
      deadline: Number(row.assignment.deadline),
      leaseUntil: Number(row.assignment.leaseUntil),
      budget: {
        maxRps: row.assignment.maxRps,
        concurrency: row.assignment.concurrency,
        durationSec: row.assignment.durationSec,
      },
      progress: row.progress ?? null,
      progressAt: row.progress_at ? Number(row.progress_at) : null,
      result: row.final_result
        ? {
            state: row.final_result.state,
            podIp: row.final_result.podIp,
            podUid: row.final_result.podUid,
            claimedAssignmentHash: row.final_result.claimedAssignmentHash,
            resources: fleetResourceMeasurements(row.final_result.resources),
            generator: row.final_result.generator
              ? fleetMeasurements(row.final_result.generator as LoadTestResult)
              : null,
          }
        : null,
    }));
  const content = {
    schema: 'ddostester.fleet.persisted-evidence/v1',
    runId: parent.run_id,
    campaignId: parent.campaign_id,
    state: parent.run_state,
    deadline: Number(parent.deadline),
    controlLeaseUntil: Number(parent.control_lease_until),
    shards,
    counterCoverage: {
      reportedAgents: shards.filter((shard) => shard.result?.generator).length,
      expectedAgents: parent.expected_agents === null ? null : Number(parent.expected_agents),
      scope: 'received-final-results-only',
    },
    isFinalizedCampaignReport: false,
    probe: null,
    baseline: null,
    targetReceipts: null,
    wrs: null,
    limitations: [
      'Durable coordinator snapshot, not a finalized campaign report.',
      'Missing probe, baseline and target receipt history is not reconstructed.',
      'Recorded shard state does not prove process termination.',
      'SHA-256 detects alteration but does not authenticate the exporter.',
    ],
  };
  return { content, sha256: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}
export async function persistedFleetEvidenceFromEnv(
  runId: string,
  env = process.env,
  campaignId?: string,
) {
  if (env.FLEET_ENABLED !== '1' || !env.DATABASE_URL) throw new Error('Fleet evidence unavailable');
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    statement_timeout: 2000,
  });
  try {
    if (campaignId) {
      const latest = await pool.query<{ run_id: string }>(
        'SELECT run_id FROM fleet_runs_v1 WHERE campaign_id=$1 ORDER BY deadline DESC LIMIT 1',
        [campaignId],
      );
      if (!latest.rows[0]) return undefined;
      runId = latest.rows[0].run_id;
    }
    return await persistedFleetEvidence(pool, runId);
  } finally {
    await pool.end();
  }
}
