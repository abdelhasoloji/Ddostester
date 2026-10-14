import pg from 'pg';
/** One SELECT snapshot. Observation never expires, reassigns or renews an agent. */
export async function inspectFleet(pool: pg.Pool, now = Date.now()) {
  const result =
    await pool.query(`SELECT r.run_id,r.state AS run_state,r.deadline,r.control_lease_until,
    s.agent_id,s.state,s.assignment,s.progress,s.progress_at
    FROM (SELECT * FROM fleet_runs_v1 ORDER BY deadline DESC LIMIT 1) r
    LEFT JOIN fleet_shards_v1 s ON s.run_id=r.run_id ORDER BY s.agent_id LIMIT 3`);
  const run = result.rows[0];
  return {
    availabilityScope: 'coordinator-read',
    observedAt: new Date(now).toISOString(),
    run: run
      ? {
          runId: run.run_id,
          state: run.run_state,
          deadline: Number(run.deadline),
          controlLeaseUntil: Number(run.control_lease_until),
          controlLeaseExpired: Number(run.control_lease_until) <= now,
        }
      : null,
    agents: result.rows
      .filter((row) => row.agent_id)
      .map((row) => ({
        agentId: row.agent_id,
        state: row.state,
        attemptId: row.assignment.attemptId,
        assignmentHash: row.assignment.configHash,
        leaseUntil: row.assignment.leaseUntil,
        leaseExpired: row.assignment.leaseUntil <= now,
        budget: {
          maxRps: row.assignment.maxRps,
          concurrency: row.assignment.concurrency,
          durationSec: row.assignment.durationSec,
        },
        progress: row.progress ?? null,
        progressAt: row.progress_at ? Number(row.progress_at) : null,
      })),
    semantics:
      'Recorded state and lease evidence; expired leases do not prove process termination.',
  };
}
export async function fleetStatusFromEnv(env = process.env) {
  if ((env.FLEET_ENABLED !== '1' && env.FLEET_MISSIONS_ENABLED !== '1') || !env.DATABASE_URL)
    return { configured: false, available: false };
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    statement_timeout: 2000,
  });
  try {
    return {
      configured: true,
      available: true,
      image: env.FLEET_AGENT_IMAGE ?? null,
      ...(await inspectFleet(pool)),
    };
  } catch {
    return { configured: true, available: false };
  } finally {
    await pool.end();
  }
}
