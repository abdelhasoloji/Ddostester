import pg from 'pg';

export interface CertificateHealth {
  expiresAt: number;
  /** Whole days remaining, floored: 3 means at least three full days are left. */
  daysRemaining: number;
  status: 'ok' | 'expiring' | 'expired';
}

/**
 * Certificate expiry, surfaced so a site cannot die silently: the mTLS leaf lasts
 * 14 days and renewal is a manual operator action. `expiring` is a seven-day
 * warning window.
 */
/**
 * A presence row older than this no longer proves the agent is running: the fleet
 * heartbeat is 2 s and the resident worker polls every second, so a minute of
 * silence means the process is gone, not merely slow.
 */
export const PRESENCE_STALE_MS = 60_000;

/**
 * Presence age, surfaced separately from certificate expiry: a decommissioned
 * agent keeps its last row forever (nothing prunes it), so "seen long ago" must
 * not read as "present now".
 */
export function presenceHealth(
  lastSeen: number,
  now = Date.now(),
): { lastSeenAgoMs: number; stale: boolean } {
  if (!Number.isFinite(lastSeen)) throw new Error('Invalid presence timestamp');
  const age = Math.max(0, now - lastSeen);
  return { lastSeenAgoMs: age, stale: age > PRESENCE_STALE_MS };
}

export function certificateHealth(expiresAt: number, now = Date.now()): CertificateHealth {
  if (!Number.isFinite(expiresAt)) throw new Error('Invalid certificate expiry');
  const remaining = expiresAt - now;
  return {
    expiresAt,
    daysRemaining: Math.floor(remaining / 86_400_000),
    status: remaining <= 0 ? 'expired' : remaining <= 7 * 86_400_000 ? 'expiring' : 'ok',
  };
}
/** One SELECT snapshot. Observation never expires, reassigns or renews an agent. */
export async function inspectFleet(pool: pg.Pool, now = Date.now()) {
  const result =
    await pool.query(`SELECT r.run_id,r.state AS run_state,r.deadline,r.control_lease_until,
    s.agent_id,s.site,s.state,s.assignment,s.progress,s.progress_at
    FROM (SELECT * FROM fleet_runs_v1 ORDER BY deadline DESC LIMIT 1) r
    LEFT JOIN fleet_shards_v1 s ON s.run_id=r.run_id ORDER BY s.agent_id LIMIT 3`);
  const run = result.rows[0];
  // Presence is advisory: a node that has not yet migrated has no presence table,
  // and a status read must not fail because of optional observability.
  let presence: { agent_id: string; site: string; cert_expires_at: string; last_seen: string }[] = [];
  try {
    presence = (
      await pool.query(
        'SELECT agent_id,site,cert_expires_at,last_seen FROM fleet_agent_presence_v1 ORDER BY agent_id',
      )
    ).rows;
  } catch {
    presence = [];
  }
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
        site: row.site,
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
    certificates: presence.map((row) => ({
      agentId: row.agent_id,
      site: row.site,
      lastSeen: Number(row.last_seen),
      ...presenceHealth(Number(row.last_seen), now),
      ...certificateHealth(Number(row.cert_expires_at), now),
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
