import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FLEET_LIMITS, HARD_CAPS } from '../src/config/limits.js';
import { FleetCoordinator } from '../src/modules/fleet/coordinator.js';
import {
  assertAggregateBudget,
  assignmentHash,
  authorizedEnvelope,
  splitBudget,
  validateAssignment,
  validatePacketMission,
  packetAssignmentHash,
  buildPacketAssignment,
  validatePacketAssignment,
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

describe('multi-site aggregate budget (M2.4)', () => {
  const policy = {
    maxRps: HARD_CAPS.maxRps,
    maxConcurrency: HARD_CAPS.maxConcurrency,
    maxDurationSec: HARD_CAPS.maxDurationSec,
  };

  it('bounds the envelope by the smallest of HARD_CAPS, the fleet envelope and policy', () => {
    expect(authorizedEnvelope(policy)).toEqual({
      maxRps: FLEET_LIMITS.maxRps,
      maxConcurrency: FLEET_LIMITS.maxConcurrency,
      maxDurationSec: FLEET_LIMITS.maxDurationSec,
    });
    expect(authorizedEnvelope({ maxRps: 10, maxConcurrency: 4, maxDurationSec: 30 })).toEqual({
      maxRps: 10,
      maxConcurrency: 4,
      maxDurationSec: 30,
    });
    expect(() =>
      authorizedEnvelope({ maxRps: HARD_CAPS.maxRps + 1, maxConcurrency: 1, maxDurationSec: 1 }),
    ).toThrow('Invalid operational caps');
  });

  it('accepts a divided aggregate that conserves and fits the envelope', () => {
    const envelope = authorizedEnvelope(policy);
    const shards = splitBudget(12, 6, 3);
    expect(() =>
      assertAggregateBudget({ maxRps: 12, concurrency: 6 }, shards, envelope),
    ).not.toThrow();
  });

  it('refuses three sites each granted the full aggregate', () => {
    const envelope = authorizedEnvelope(policy);
    // The classic multi-site bug: every site is handed the whole budget.
    const duplicated = [
      { maxRps: 12, concurrency: 6 },
      { maxRps: 12, concurrency: 6 },
      { maxRps: 12, concurrency: 6 },
    ];
    expect(() =>
      assertAggregateBudget({ maxRps: 12, concurrency: 6 }, duplicated, envelope),
    ).toThrow('do not conserve');
  });

  it('refuses an aggregate above the authorized envelope', () => {
    const envelope = authorizedEnvelope(policy);
    const shards = splitBudget(FLEET_LIMITS.maxRps + 1, 6, 3);
    expect(() =>
      assertAggregateBudget({ maxRps: FLEET_LIMITS.maxRps + 1, concurrency: 6 }, shards, envelope),
    ).toThrow('exceeds authorized envelope');
  });

  it('refuses more shards than the fleet can run', () => {
    const envelope = authorizedEnvelope(policy);
    const shards = Array.from({ length: FLEET_LIMITS.maxAgents + 1 }, () => ({
      maxRps: 1,
      concurrency: 1,
    }));
    expect(() =>
      assertAggregateBudget(
        { maxRps: shards.length, concurrency: shards.length },
        shards,
        envelope,
      ),
    ).toThrow('Invalid fleet shard count');
  });

  it('conserves the aggregate and never exceeds the envelope for any valid split', () => {
    const envelope = authorizedEnvelope(policy);
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: FLEET_LIMITS.maxRps }),
        fc.integer({ min: 3, max: FLEET_LIMITS.maxConcurrency }),
        fc.integer({ min: 1, max: FLEET_LIMITS.maxAgents }),
        (maxRps, concurrency, agents) => {
          const rps = Math.max(maxRps, agents);
          const conc = Math.max(concurrency, agents);
          const shards = splitBudget(rps, conc, agents);
          assertAggregateBudget({ maxRps: rps, concurrency: conc }, shards, envelope);
          expect(shards.reduce((n, s) => n + s.maxRps, 0)).toBe(rps);
          expect(shards.reduce((n, s) => n + s.concurrency, 0)).toBe(conc);
          expect(Math.max(...shards.map((s) => s.maxRps))).toBeLessThanOrEqual(envelope.maxRps);
        },
      ),
    );
  });
});

describe('packet mission bounds', () => {
  const limits = { maxPps: 50_000, packetPorts: [18099], minDurationSec: 10, maxDurationSec: 60 };
  it('accepts a mission inside the bounds', () => {
    expect(
      validatePacketMission({ kind: 'syn', port: 18099, pps: 25_000, durationSec: 10 }, limits),
    ).toEqual({
      kind: 'syn',
      port: 18099,
      pps: 25_000,
      durationSec: 10,
    });
  });
  it('refuses a rate above the bound instead of reducing it', () => {
    expect(() =>
      validatePacketMission({ kind: 'syn', port: 18099, pps: 250_000, durationSec: 10 }, limits),
    ).toThrow(/rate exceeds/);
  });
  it('refuses a port that is not declared', () => {
    expect(() =>
      validatePacketMission({ kind: 'syn', port: 22, pps: 100, durationSec: 10 }, limits),
    ).toThrow(/port is forbidden/);
  });
  it('refuses unknown fields and unknown vectors', () => {
    expect(() =>
      validatePacketMission(
        { kind: 'syn', port: 18099, pps: 100, durationSec: 10, maxRps: 5 },
        limits,
      ),
    ).toThrow(/unknown fields/);
    expect(() =>
      validatePacketMission({ kind: 'udp', port: 18099, pps: 100, durationSec: 10 }, limits),
    ).toThrow(/Unsupported packet vector/);
  });
  it('refuses a duration outside the fleet window', () => {
    expect(() =>
      validatePacketMission({ kind: 'syn', port: 18099, pps: 100, durationSec: 5 }, limits),
    ).toThrow(/duration is out of bounds/);
  });
});

describe('packet assignment v3', () => {
  const now = 1_800_000_000_000;
  const policy = {
    agentId: 'three',
    allowedHosts: ['lab-target'],
    allowedPorts: [18099],
    maxPps: 50_000,
    minDurationSec: 10,
    maxDurationSec: 60,
    now,
  };
  const base = {
    schema: 'ddostester.fleet.assignment/v3' as const,
    campaignId: 'c1',
    runId: 'r1',
    agentId: 'three',
    attemptId: 'a1',
    target: 'http://lab-target:18099/',
    port: 18099,
    pps: 25_000,
    durationSec: 10,
    notBefore: now,
    deadline: now + 10_000,
    leaseUntil: now + 10_000,
  };
  const signed = () => ({ ...base, configHash: packetAssignmentHash(base) });

  it('accepts a signed, in-window packet assignment', () => {
    expect(validatePacketAssignment(signed(), policy).pps).toBe(25_000);
  });

  it('refuses an assignment for another agent', () => {
    const a = { ...signed(), agentId: 'one' };
    expect(() => validatePacketAssignment(a, policy)).toThrow(/another agent/);
  });

  it('refuses a hash mismatch', () => {
    const a = { ...signed(), pps: 49_000 };
    expect(() => validatePacketAssignment(a, policy)).toThrow(/hash mismatch/);
  });

  it('refuses a rate above the bound even when signed', () => {
    const big = { ...base, pps: 250_000 };
    const a = { ...big, configHash: packetAssignmentHash(big) };
    expect(() => validatePacketAssignment(a, policy)).toThrow(/exceeds the fleet bound/);
  });

  it('refuses a forbidden port and an expired lease', () => {
    const badPort = { ...base, port: 22 };
    expect(() =>
      validatePacketAssignment({ ...badPort, configHash: packetAssignmentHash(badPort) }, policy),
    ).toThrow(/port is forbidden/);
    const expired = { ...base, leaseUntil: now - 1, deadline: now + 10_000 };
    expect(() =>
      validatePacketAssignment({ ...expired, configHash: packetAssignmentHash(expired) }, policy),
    ).toThrow(/lifetime/);
  });
});

describe('packet assignment fabrication', () => {
  const now = 1_800_000_000_000;
  const policy = {
    agentId: 'three',
    allowedHosts: ['lab-target'],
    allowedPorts: [18099],
    maxPps: 50_000,
    minDurationSec: 10,
    maxDurationSec: 60,
    now,
  };
  const build = () =>
    buildPacketAssignment({
      campaignId: 'c1',
      runId: 'r1',
      agentId: 'three',
      attemptId: 'a1',
      target: 'http://lab-target:18099/',
      port: 18099,
      pps: 25_000,
      durationSec: 10,
      now,
    });

  it('produces an assignment the validator accepts', () => {
    expect(validatePacketAssignment(build(), policy).pps).toBe(25_000);
  });

  it('closes the window after the mission duration and never leases beyond it', () => {
    const a = build();
    expect(a.notBefore).toBe(now);
    expect(a.deadline).toBe(now + 10_000);
    expect(a.leaseUntil).toBeLessThanOrEqual(a.deadline);
  });

  it('invalidates the signature when an input changes', () => {
    const a = build();
    const b = buildPacketAssignment({
      campaignId: 'c1',
      runId: 'r1',
      agentId: 'three',
      attemptId: 'a1',
      target: 'http://lab-target:18099/',
      port: 18099,
      pps: 30_000,
      durationSec: 10,
      now,
    });
    expect(a.configHash).not.toBe(b.configHash);
  });
});

describe('coordinator claim routing (v1/v2 unchanged, v3 validated)', () => {
  const now = 1_800_000_000_000;
  const packet = buildPacketAssignment({
    campaignId: 'c1',
    runId: 'r1',
    agentId: 'three',
    attemptId: 'a1',
    target: 'http://lab-target:18099/',
    port: 18099,
    pps: 25_000,
    durationSec: 10,
    now,
  });
  const v2 = assignment({
    schema: 'ddostester.fleet.assignment/v2',
    iotProfile: { id: 'sensor-heartbeat/v1', seed: 42, deviceIndex: 0 },
    probeUrl: 'http://target.test:8080/status',
    notBefore: now,
    deadline: now + 10_000,
    leaseUntil: now + 10_000,
  });

  const claim = async (stored: unknown) => {
    const updates: { text: string; values?: unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
        if (text.startsWith('SELECT * FROM fleet_runs_v1'))
          return {
            rows: [
              {
                run_id: 'r1',
                state: 'RUNNING',
                deadline: now + 60_000,
                control_lease_until: now + 60_000,
              },
            ],
          };
        if (text.startsWith('SELECT * FROM fleet_shards_v1'))
          return { rows: [{ state: 'PENDING', assignment: stored }] };
        updates.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client };
    const coordinator = new FleetCoordinator(pool as never, () => now);
    return { assignment: await coordinator.claim('r1', 'three'), updates };
  };

  it('accepts a v3 assignment at claim and re-signs the shorter lease', async () => {
    const { assignment: claimed, updates } = await claim(packet);
    expect(claimed?.schema).toBe('ddostester.fleet.assignment/v3');
    expect(claimed && 'pps' in claimed ? claimed.pps : undefined).toBe(25_000);
    expect(claimed?.leaseUntil).toBe(now + FLEET_LIMITS.leaseMs);
    expect(claimed?.configHash).not.toBe(packet.configHash);
    expect(updates).toHaveLength(1);
  });

  it('still accepts a v2 assignment at claim', async () => {
    const { assignment: claimed } = await claim(v2);
    expect(claimed?.schema).toBe('ddostester.fleet.assignment/v2');
    expect(claimed?.agentId).toBe('agent-1');
  });

  it('refuses a v3 assignment altered after signing', async () => {
    const altered = { ...packet, pps: 30_000 };
    await expect(claim(altered)).rejects.toThrow(/hash mismatch/);
  });
});
