import { createHash } from 'node:crypto';
import { FLEET_LIMITS, withinCeiling, type HardCaps } from '../../config/limits.js';
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
