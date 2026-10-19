/**
 * Capacity-derived budget for a DRS exposure.
 *
 * The execution budget used to be a constant (`FLEET_LIMITS`): 15 rps, 6 workers,
 * 3 agents, 60 s. That makes every archived DRS level unreachable by construction —
 * level 1 alone asks for 500 tps and 10 independent bots — so qualification could
 * only ever answer "INCONCLUSIVE". This module derives the budget instead:
 *
 *   capacity = Σ measuredTps(agent) × derating
 *   envelope = min(signedScope, capacity, serviceCeiling)
 *
 * The signed scope is the binding constraint; capacity is measured, never assumed.
 * An agent without a calibration has capacity 0 and is not admitted, so a fleet that
 * cannot reach the scope produces a refusal and a stated gap rather than a run that
 * silently under-delivers.
 */

/** Parse an archived quantity like "200K", "25M" or "100G" into a number. */
export function parseQuantity(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)([KMGTP]?)$/.exec(raw.trim());
  return m
    ? Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[m[2]] ?? NaN)
    : null;
}

export interface AgentCapacity {
  id: string;
  /** Requests per second the agent actually sustained in its calibration run. */
  measuredTps: number;
  /** Concurrent in-flight requests sustained at that rate. */
  measuredConcurrency: number;
  /** ISO timestamp of the calibration. Presence is what admits an agent. */
  measuredAt: string;
  /** Free-form conditions the number was measured under (TLS, RTT, node class). */
  conditions?: string;
}

export interface SignedScope {
  /** Authorized ceiling for this test, signed by the target owner. */
  maxRps: number;
  maxConcurrency: number;
  maxDurationSec: number;
  /** Targets the scope covers; the campaign allowlist is applied separately. */
  targets: string[];
  /** ISO window the exposure is authorized in. */
  windowStart?: string;
  windowEnd?: string;
}

export interface ServiceCeiling {
  maxRps: number;
  maxConcurrency: number;
  maxDurationSec: number;
}

export type EnvelopeLimit = 'scope' | 'capacity' | 'ceiling';

export interface Envelope {
  maxRps: number;
  maxConcurrency: number;
  maxDurationSec: number;
  /** Number of agents with a usable calibration. */
  agents: number;
  limitedBy: { rps: EnvelopeLimit; concurrency: EnvelopeLimit };
  warnings: string[];
}

const DEFAULT_DERATING = 0.8;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Admitted capacity: only agents with a recorded, positive calibration count. */
export function admittedCapacity(agents: readonly AgentCapacity[], derating = DEFAULT_DERATING) {
  const admitted = agents.filter(
    (a) => positive(a.measuredTps) && positive(a.measuredConcurrency) && Boolean(a.measuredAt),
  );
  return {
    admitted,
    excluded: agents.filter((a) => !admitted.includes(a)).map((a) => a.id),
    tps: admitted.reduce((sum, a) => sum + a.measuredTps, 0) * derating,
    concurrency: admitted.reduce((sum, a) => sum + a.measuredConcurrency, 0) * derating,
  };
}

/** The binding budget for one exposure: the smallest of scope, capacity and ceiling. */
export function deriveEnvelope(input: {
  scope: SignedScope;
  agents: readonly AgentCapacity[];
  ceiling: ServiceCeiling;
  derating?: number;
}): Envelope {
  const { scope, agents, ceiling } = input;
  const capacity = admittedCapacity(agents, input.derating ?? DEFAULT_DERATING);
  const warnings: string[] = [];

  if (capacity.excluded.length)
    warnings.push(
      `${capacity.excluded.length} agent(s) without a usable calibration were not admitted: ${capacity.excluded.join(', ')}`,
    );
  if (!capacity.admitted.length)
    warnings.push('No admitted agent: capacity is zero and no exposure can start.');

  const pick = (candidates: [EnvelopeLimit, number][]) =>
    candidates.reduce(
      (best, candidate) => (candidate[1] < best[1] ? candidate : best),
      candidates[0],
    );

  const rps = pick([
    ['scope', scope.maxRps],
    ['capacity', capacity.tps],
    ['ceiling', ceiling.maxRps],
  ]);
  const concurrency = pick([
    ['scope', scope.maxConcurrency],
    ['capacity', capacity.concurrency],
    ['ceiling', ceiling.maxConcurrency],
  ]);

  if (rps[0] === 'capacity')
    warnings.push(
      `Scope asks for ${scope.maxRps} rps but admitted capacity is ${Math.round(capacity.tps)} rps; the exposure is capped by the fleet.`,
    );
  if (rps[0] === 'ceiling')
    warnings.push(
      `Scope asks for ${scope.maxRps} rps but the service ceiling is ${ceiling.maxRps} rps; raise SERVICE_CEILING deliberately to exceed it.`,
    );

  return {
    maxRps: Math.floor(Math.min(rps[1], scope.maxRps)),
    maxConcurrency: Math.floor(Math.min(concurrency[1], scope.maxConcurrency)),
    maxDurationSec: Math.min(scope.maxDurationSec, ceiling.maxDurationSec),
    agents: capacity.admitted.length,
    limitedBy: { rps: rps[0], concurrency: concurrency[0] },
    warnings,
  };
}

export interface LevelReach {
  level: number;
  total: number;
  reachable: number;
  unreachable: { vectorId: string; missing: string[] }[];
}

/** Which archived vectors the envelope can actually reach, per level.
 *  Deliberately conservative: a vector is reachable only when both the load line
 *  and the source count are covered. It never claims a level the fleet cannot meet. */
export function levelReachability(
  vectors: readonly {
    internal_id: string;
    level: number;
    load_requirements: Record<string, string>;
    service_requirements: Record<string, string>;
  }[],
  envelope: Pick<Envelope, 'maxRps' | 'agents'>,
  parse: { quantity: (raw: string | undefined) => number | null },
): LevelReach[] {
  const byLevel = new Map<number, LevelReach>();
  for (const v of vectors) {
    const entry = byLevel.get(v.level) ?? {
      level: v.level,
      total: 0,
      reachable: 0,
      unreachable: [],
    };
    entry.total += 1;
    const missing: string[] = [];
    for (const [name, raw] of Object.entries(v.load_requirements ?? {})) {
      const unit = name.slice(4);
      const needed = parse.quantity(raw);
      if (needed === null) continue;
      // Only tps is comparable to the envelope; bps/pps are not produced by this
      // fleet and are reported as unmet rather than silently satisfied.
      if (unit !== 'tps') missing.push(`${raw} ${unit} (no generator for this unit)`);
      else if (needed > envelope.maxRps) missing.push(`${raw} tps (envelope ${envelope.maxRps})`);
    }
    const bots = parse.quantity(v.service_requirements?.max_bots);
    if (bots !== null && bots > envelope.agents)
      missing.push(`${bots} bots (${envelope.agents} admitted)`);
    if (missing.length) entry.unreachable.push({ vectorId: v.internal_id, missing });
    else entry.reachable += 1;
    byLevel.set(v.level, entry);
  }
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}
