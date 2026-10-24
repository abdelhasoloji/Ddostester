import { createHash } from 'node:crypto';
import { FLEET_LIMITS, HARD_CAPS, withinCeiling, type HardCaps } from '../../config/limits.js';
import { assertDestination } from '../../util/destination.js';
import { compileIoTProfile, type IoTProfile } from '../../engine/iot-profile.js';

export interface FleetAssignment {
  schema: 'ddostester.fleet.assignment/v1' | 'ddostester.fleet.assignment/v2';
  iotProfile?: IoTProfile;
  probeUrl?: string;
  campaignId: string;
  runId: string;
  agentId: string;
  attemptId: string;
  target: string;
  maxRps: number;
  concurrency: number;
  durationSec: number;
  notBefore: number;
  deadline: number;
  leaseUntil: number;
  configHash: string;
}
export type AssignmentInput = Omit<FleetAssignment, 'configHash'>;
const keys = [
  'schema',
  'campaignId',
  'runId',
  'agentId',
  'attemptId',
  'target',
  'maxRps',
  'concurrency',
  'durationSec',
  'notBefore',
  'deadline',
  'leaseUntil',
  'configHash',
].sort();
export function assignmentHash(input: AssignmentInput): string {
  const ordered = Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}
/** All policy inputs are trusted coordinator state, never values supplied by an agent. */
export function validateAssignment(
  value: unknown,
  policy: {
    agentId: string;
    allowedHosts: string[];
    allowedPorts: number[];
    caps: HardCaps;
    now: number;
  },
): FleetAssignment {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid assignment');
  const x = value as FleetAssignment;
  const expectedKeys =
    x.schema === 'ddostester.fleet.assignment/v2'
      ? [...keys, 'iotProfile', 'probeUrl'].sort()
      : keys;
  if (Object.keys(x).sort().join(',') !== expectedKeys.join(','))
    throw new Error('Assignment fields mismatch');
  if (
    x.schema !== 'ddostester.fleet.assignment/v1' &&
    x.schema !== 'ddostester.fleet.assignment/v2'
  )
    throw new Error('Unsupported assignment schema');
  for (const key of ['campaignId', 'runId', 'agentId', 'attemptId'] as const) {
    if (typeof x[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(x[key]))
      throw new Error('Invalid assignment identity');
  }
  if (x.agentId !== policy.agentId) throw new Error('Assignment belongs to another agent');
  if (!withinCeiling(policy.caps)) throw new Error('Invalid operational caps');
  for (const [v, cap] of [
    [x.maxRps, policy.caps.maxRps],
    [x.concurrency, policy.caps.maxConcurrency],
    [x.durationSec, policy.caps.maxDurationSec],
  ]) {
    if (!Number.isSafeInteger(v) || v < 1 || v > cap)
      throw new Error('Assignment exceeds operational caps');
  }
  for (const t of [x.notBefore, x.deadline, x.leaseUntil])
    if (!Number.isSafeInteger(t)) throw new Error('Invalid assignment clock');
  if (
    x.notBefore > policy.now ||
    x.deadline <= policy.now ||
    x.leaseUntil <= policy.now ||
    x.leaseUntil > x.deadline ||
    x.leaseUntil - policy.now > FLEET_LIMITS.leaseMs ||
    x.deadline - x.notBefore > x.durationSec * 1000
  )
    throw new Error('Invalid or expired assignment lifetime');
  if (typeof x.target !== 'string') throw new Error('Invalid assignment destination');
  const target = assertDestination(x.target, policy.allowedHosts);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (!policy.allowedPorts.includes(port)) throw new Error('Assignment port is forbidden');
  if (x.schema === 'ddostester.fleet.assignment/v2') {
    if (!x.iotProfile || Object.keys(x.iotProfile).sort().join(',') !== 'deviceIndex,id,seed')
      throw new Error('Invalid IoT assignment profile');
    if (typeof x.probeUrl !== 'string')
      throw new Error('IoT assignment requires campaign probe URL');
    const probe = assertDestination(x.probeUrl, policy.allowedHosts);
    const probePort = Number(probe.port || (probe.protocol === 'https:' ? 443 : 80));
    if (!policy.allowedPorts.includes(probePort)) throw new Error('Probe port is forbidden');
    compileIoTProfile(x.iotProfile, x.target, x.probeUrl);
  }
  const { configHash, ...input } = x;
  if (typeof configHash !== 'string' || configHash !== assignmentHash(input))
    throw new Error('Assignment hash mismatch');
  return { ...x };
}
/** Integer shards conserve BOTH budgets; never round each allocation upwards. */
export function splitBudget(
  maxRps: number,
  concurrency: number,
  agents: number,
): { maxRps: number; concurrency: number }[] {
  if (
    ![maxRps, concurrency, agents].every(Number.isSafeInteger) ||
    agents < 1 ||
    agents > FLEET_LIMITS.maxAgents ||
    maxRps < agents ||
    concurrency < agents
  )
    throw new Error('Invalid fleet budget');
  if (!withinCeiling({ maxRps, maxConcurrency: concurrency, maxDurationSec: 1 }))
    throw new Error('Fleet budget exceeds HARD_CAPS');
  const share = (total: number, i: number) =>
    Math.floor(total / agents) + (i < total % agents ? 1 : 0);
  return Array.from({ length: agents }, (_, i) => ({
    maxRps: share(maxRps, i),
    concurrency: share(concurrency, i),
  }));
}

/**
 * The authorized envelope for ONE fleet run: the smallest of the frozen HARD_CAPS
 * ceiling, the fleet's own shared envelope (`FLEET_LIMITS`) and the cap supplied
 * by the operator policy (the fleet-policy ConfigMap). Every shard, and therefore
 * every participating site, is bounded by this single object — a second site can
 * never widen it.
 */
export function authorizedEnvelope(policy: HardCaps): HardCaps {
  if (!withinCeiling(policy)) throw new Error('Invalid operational caps');
  return {
    maxRps: Math.min(HARD_CAPS.maxRps, FLEET_LIMITS.maxRps, policy.maxRps),
    maxConcurrency: Math.min(
      HARD_CAPS.maxConcurrency,
      FLEET_LIMITS.maxConcurrency,
      policy.maxConcurrency,
    ),
    maxDurationSec: Math.min(
      HARD_CAPS.maxDurationSec,
      FLEET_LIMITS.maxDurationSec,
      policy.maxDurationSec,
    ),
  };
}

/**
 * The multi-site invariant: shards must conserve the requested aggregate exactly
 * and never exceed the authorized envelope.
 *
 * This is the rule that stops N sites from multiplying the budget by N. The
 * aggregate is authorized ONCE, then divided; every shard is derived from that
 * one number, and the sum is re-checked after division so a remote executor
 * cannot hand out fresh budgets per site.
 */
export function assertAggregateBudget(
  requested: { maxRps: number; concurrency: number },
  shards: readonly { maxRps: number; concurrency: number }[],
  envelope: HardCaps,
): void {
  if (shards.length < 1 || shards.length > FLEET_LIMITS.maxAgents)
    throw new Error('Invalid fleet shard count');
  if (
    !Number.isSafeInteger(requested.maxRps) ||
    !Number.isSafeInteger(requested.concurrency) ||
    requested.maxRps < 1 ||
    requested.concurrency < 1
  )
    throw new Error('Invalid aggregate budget');
  if (requested.maxRps > envelope.maxRps || requested.concurrency > envelope.maxConcurrency)
    throw new Error('Aggregate budget exceeds authorized envelope');
  let rps = 0;
  let concurrency = 0;
  for (const shard of shards) {
    if (!Number.isSafeInteger(shard.maxRps) || shard.maxRps < 1)
      throw new Error('Invalid fleet shard');
    if (!Number.isSafeInteger(shard.concurrency) || shard.concurrency < 1)
      throw new Error('Invalid fleet shard');
    rps += shard.maxRps;
    concurrency += shard.concurrency;
  }
  if (rps !== requested.maxRps || concurrency !== requested.concurrency)
    throw new Error('Fleet shards do not conserve the aggregate budget');
  if (rps > envelope.maxRps || concurrency > envelope.maxConcurrency)
    throw new Error('Fleet shards exceed authorized envelope');
}

/**
 * Packet mission request, validated before it ever becomes a signed assignment.
 *
 * The packet vector is not an HTTP campaign with a different label: it has its
 * own bound (packets per second), its own destination (a single port) and no
 * concurrency. Anything out of bounds is refused, never reduced silently.
 */
export interface PacketMissionInput {
  kind: 'syn';
  port: number;
  pps: number;
  durationSec: number;
}

export function validatePacketMission(
  value: unknown,
  limits: { maxPps: number; packetPorts: number[]; minDurationSec: number; maxDurationSec: number },
): PacketMissionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid packet mission');
  const x = value as Record<string, unknown>;
  if (Object.keys(x).some((k) => !['kind', 'port', 'pps', 'durationSec'].includes(k)))
    throw new Error('Packet mission carries unknown fields');
  if (x.kind !== 'syn') throw new Error('Unsupported packet vector');
  if (!Number.isSafeInteger(x.port) || !limits.packetPorts.includes(x.port as number))
    throw new Error('Packet port is forbidden');
  if (!Number.isSafeInteger(x.pps) || (x.pps as number) < 1 || (x.pps as number) > limits.maxPps)
    throw new Error('Packet rate exceeds the fleet bound');
  if (
    !Number.isSafeInteger(x.durationSec) ||
    (x.durationSec as number) < limits.minDurationSec ||
    (x.durationSec as number) > limits.maxDurationSec
  )
    throw new Error('Packet duration is out of bounds');
  return {
    kind: 'syn',
    port: x.port as number,
    pps: x.pps as number,
    durationSec: x.durationSec as number,
  };
}
