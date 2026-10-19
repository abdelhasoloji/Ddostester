/**
 * Measured capacity of one load agent.
 *
 * The DRS envelope is derived from these rows, never from a constant: an agent that
 * has not recorded a calibration contributes zero and is not admitted. A calibration
 * is a claim about a specific agent under specific conditions (TLS, RTT, node class),
 * so the conditions string is part of the record and is shown in the report.
 */
export interface AgentCalibration {
  agentId: string;
  /** Requests per second the agent sustained, measured end to end. */
  measuredTps: number;
  /** Concurrent in-flight requests sustained at that rate. */
  measuredConcurrency: number;
  measuredAt: string;
  conditions?: string;
}

export class CalibrationError extends Error {}

const MAX_TPS = 5_000_000;
const MAX_CONCURRENCY = 100_000;

/** Accepts the wire shape and returns a normalized record, or throws with the reason. */
export function parseCalibration(raw: unknown): AgentCalibration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new CalibrationError('calibration must be an object');
  const r = raw as Record<string, unknown>;
  const agentId = typeof r.agentId === 'string' ? r.agentId.trim() : '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(agentId))
    throw new CalibrationError('agentId must be 1-64 chars of [A-Za-z0-9._-]');
  const tps = Number(r.measuredTps);
  if (!Number.isFinite(tps) || tps <= 0 || tps > MAX_TPS)
    throw new CalibrationError(`measuredTps must be within (0, ${MAX_TPS}]`);
  const concurrency = Number(r.measuredConcurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY)
    throw new CalibrationError(
      `measuredConcurrency must be an integer within [1, ${MAX_CONCURRENCY}]`,
    );
  const measuredAt = typeof r.measuredAt === 'string' ? r.measuredAt : '';
  const at = Date.parse(measuredAt);
  if (Number.isNaN(at)) throw new CalibrationError('measuredAt must be an ISO timestamp');
  if (at > Date.now() + 60_000) throw new CalibrationError('measuredAt cannot be in the future');
  const conditions = typeof r.conditions === 'string' ? r.conditions.slice(0, 200) : undefined;
  return { agentId, measuredTps: tps, measuredConcurrency: concurrency, measuredAt, conditions };
}
