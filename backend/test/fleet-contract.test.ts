import { describe, expect, it } from 'vitest';
import {
  assignmentHash,
  splitBudget,
  validateAssignment,
  type AssignmentInput,
} from '../src/modules/fleet/contract.js';
const input: AssignmentInput = {
  schema: 'ddostester.fleet.assignment/v1',
  campaignId: 'campaign',
  runId: 'run',
  agentId: 'agent-1',
  attemptId: 'attempt-1',
  target: 'http://target.test:8080/',
  maxRps: 5,
  concurrency: 2,
  durationSec: 10,
  notBefore: 1000,
  deadline: 11000,
  leaseUntil: 7000,
};
const policy = {
  agentId: 'agent-1',
  allowedHosts: ['target.test'],
  allowedPorts: [8080],
  caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
  now: 1000,
};
const assignment = (over: Partial<AssignmentInput> = {}) => {
  const x = { ...input, ...over };
  return { ...x, configHash: assignmentHash(x) };
};
describe('fleet contract before any transport', () => {
  it('uses explicit campaign URLs for the IoT journey and binds them to the hash', () => {
    const iot: Partial<AssignmentInput> = {
      schema: 'ddostester.fleet.assignment/v2',
      iotProfile: { id: 'sensor-heartbeat/v1', seed: 42, deviceIndex: 0 },
      target: 'http://target.test:8080/api/telemetry',
      probeUrl: 'http://target.test:8080/status',
    };
    expect(validateAssignment(assignment(iot), policy).probeUrl).toBe(iot.probeUrl);
    expect(() => validateAssignment(assignment({ ...iot, probeUrl: undefined }), policy)).toThrow();
    expect(() =>
      validateAssignment(assignment({ ...iot, probeUrl: 'http://outside.test/status' }), policy),
    ).toThrow();
    expect(() =>
      validateAssignment(
        { ...assignment(iot), probeUrl: 'http://target.test:8080/changed' },
        policy,
      ),
    ).toThrow(/hash/);
    expect(() =>
      validateAssignment(assignment({ ...iot, probeUrl: 'https://target.test/status' }), policy),
    ).toThrow();
  });
  it('accepts only an agent-bound, hash-checked current assignment', () => {
    expect(validateAssignment(assignment(), policy).agentId).toBe('agent-1');
  });
  it.each([
    { agentId: 'other' },
    { target: 'http://outside.test/' },
    { target: 'http://target.test:9090/' },
    { maxRps: 16 },
    { concurrency: 0 },
    { leaseUntil: 999 },
    { deadline: 999 },
    { leaseUntil: 8000 },
    { durationSec: Infinity },
  ])('rejects unsafe assignment %j', (over) => {
    expect(() => validateAssignment(assignment(over), policy)).toThrow();
  });
  it('rejects extra executable fields and changed contents', () => {
    expect(() => validateAssignment({ ...assignment(), command: 'shell' }, policy)).toThrow();
    expect(() => validateAssignment({ ...assignment(), maxRps: 6 }, policy)).toThrow(/hash/);
  });
  it('conserves aggregate budgets across integer shards', () => {
    for (let rps = 3; rps <= 100; rps++) {
      const shards = splitBudget(rps, 7, 3);
      expect(shards.reduce((n, x) => n + x.maxRps, 0)).toBe(rps);
      expect(shards.reduce((n, x) => n + x.concurrency, 0)).toBe(7);
    }
    expect(() => splitBudget(2001, 3, 3)).toThrow();
    expect(() => splitBudget(2, 3, 3)).toThrow();
  });
});
