import { describe, expect, it } from 'vitest';
import { admitAgents, calibrationAgeDays } from '../src/modules/drs/fleet.js';
import { parseAgentInput, parseAgentState } from '../src/modules/drs/agent.js';
import type { AgentCalibration } from '../src/modules/drs/calibration.js';
import type { DrsAgent } from '../src/modules/drs/agent.js';

const calibration = (agentId: string, measuredAt: string) =>
  ({
    agentId,
    measuredTps: 5000,
    measuredConcurrency: 200,
    measuredAt,
    conditions: 'TLS off',
  }) as AgentCalibration;

const agent = (id: string, state: DrsAgent['state']): DrsAgent => ({
  id,
  label: id,
  state,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const NOW = new Date('2026-10-21T00:00:00.000Z');

describe('fleet admission', () => {
  it('admits an active, fresh agent and reports what each agent contributes', () => {
    const result = admitAgents(
      [calibration('gen-1', '2026-10-18T00:00:00.000Z')],
      [agent('gen-1', 'active')],
      { now: NOW },
    );
    expect(result.admitted).toHaveLength(1);
    expect(result.admitted[0]).toMatchObject({ id: 'gen-1', label: 'gen-1', measuredTps: 5000 });
    expect(result.excluded).toHaveLength(0);
  });

  it('excludes maintenance and retired agents, keeping the reason', () => {
    const result = admitAgents(
      [
        calibration('gen-m', '2026-10-18T00:00:00.000Z'),
        calibration('gen-r', '2026-10-18T00:00:00.000Z'),
      ],
      [agent('gen-m', 'maintenance'), agent('gen-r', 'retired')],
      { now: NOW },
    );
    expect(result.admitted).toHaveLength(0);
    expect(result.excluded.map((e) => e.reason)).toEqual(['maintenance', 'retired']);
  });

  it('excludes a stale calibration and says how old it is', () => {
    const result = admitAgents(
      [calibration('gen-old', '2026-09-01T00:00:00.000Z')],
      [agent('gen-old', 'active')],
      { now: NOW, ttlDays: 30 },
    );
    expect(result.admitted).toHaveLength(0);
    expect(result.excluded[0].reason).toBe('calibration-expired');
    expect(result.excluded[0].detail).toContain('50 days');
    expect(calibrationAgeDays('2026-09-01T00:00:00.000Z', NOW)).toBe(50);
  });

  it('treats an agent without a fleet record as active', () => {
    const result = admitAgents([calibration('legacy', '2026-10-18T00:00:00.000Z')], [], {
      now: NOW,
    });
    expect(result.admitted).toHaveLength(1);
  });
});

describe('agent input', () => {
  it('accepts a label with an optional region and tags, and refuses a bad state', () => {
    expect(
      parseAgentInput({ label: 'gen-vps2', region: 'eu-west', tags: ['prod', 'prod'] }),
    ).toEqual({
      label: 'gen-vps2',
      region: 'eu-west',
      tags: ['prod'],
    });
    expect(() => parseAgentInput({ label: 'x' })).toThrow(/label/);
    expect(() => parseAgentState('paused')).toThrow(/state/);
    expect(parseAgentState('maintenance')).toBe('maintenance');
  });
});
