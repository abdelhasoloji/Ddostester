/**
 * Configurable ceiling for a DRS exposure.
 *
 * The frozen-plan check used to compare against `FLEET_LIMITS` (15 rps, 6 concurrent,
 * 60 s, 3 agents). That constant is a conservative transport cap for the Job-based path,
 * but it also made every DRS plan above 15 rps impossible to freeze — while the
 * immutable safety guard (`HARD_CAPS`, 2 000 rps / 500 concurrent / 900 s) already
 * bounds a laboratory exposure.
 *
 * This ceiling is what the product may raise deliberately for a larger fleet:
 *
 *   SERVICE_CEILING_RPS / _CONCURRENCY / _DURATION / _AGENTS
 *
 * The default is the immutable hard cap, so nothing escalates silently. The signed
 * scope and the measured fleet capacity still bound the envelope *below* this value;
 * the ceiling is the outer limit the deployment is willing to operate at.
 */
import { HARD_CAPS, FLEET_LIMITS } from './limits.js';

export interface DrsServiceCeiling {
  maxRps: number;
  maxConcurrency: number;
  maxDurationSec: number;
  maxAgents: number;
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function serviceCeiling(env: NodeJS.ProcessEnv = process.env): DrsServiceCeiling {
  return {
    maxRps: Math.min(HARD_CAPS.maxRps, positive(env.SERVICE_CEILING_RPS, HARD_CAPS.maxRps)),
    maxConcurrency: Math.min(
      HARD_CAPS.maxConcurrency,
      positive(env.SERVICE_CEILING_CONCURRENCY, HARD_CAPS.maxConcurrency),
    ),
    maxDurationSec: Math.min(
      HARD_CAPS.maxDurationSec,
      positive(env.SERVICE_CEILING_DURATION, HARD_CAPS.maxDurationSec),
    ),
    maxAgents: positive(env.SERVICE_CEILING_AGENTS, FLEET_LIMITS.maxAgents),
  };
}
