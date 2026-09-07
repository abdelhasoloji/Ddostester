import { describe, expect, it } from 'vitest';
import {
  OBJECTIVES,
  getObjective,
  templatesForObjective,
  recommendTemplate,
  withinCaps,
  capBreach,
  peakRps,
  totalDurationSec,
  estRequests,
  lastWrsFor,
  type RecoContext,
} from './recommend.js';
import type { HardCaps, Playbook, WrsSeries } from './api.js';

const CAPS: HardCaps = { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 };
const engines = [
  { id: 'builtin', available: true },
  { id: 'k6', available: true },
  { id: 'vegeta', available: true },
];

const step = (o: Partial<Playbook['steps'][number]> = {}): Playbook['steps'][number] => ({
  name: 'S',
  summary: '',
  maxRps: 500,
  concurrency: 100,
  maxDurationSec: 120,
  profile: 'wave',
  agent: 'builtin',
  ...o,
});
const playbook = (o: Partial<Playbook> = {}): Playbook => ({
  id: 'pb',
  name: 'PB',
  category: 'Threat-informed',
  summary: '',
  when: '',
  drsLevel: 4,
  steps: [step()],
  ...o,
});

describe('objectives', () => {
  it('exposes 5 objectives, each resolvable by id', () => {
    expect(OBJECTIVES).toHaveLength(5);
    for (const o of OBJECTIVES) expect(getObjective(o.id)).toBe(o);
  });

  it('maps an objective to real presets and/or playbooks', () => {
    const cap = getObjective('capacity')!;
    const { single, suite } = templatesForObjective(cap, [playbook({ id: 'capacity-assessment' })]);
    expect(single.map((t) => t.id)).toEqual(['baseline', 'ramp', 'ceiling']);
    expect(suite.map((t) => t.id)).toContain('capacity-assessment');
  });

  it('threat objective pulls every Threat-informed playbook by category', () => {
    const threat = getObjective('threat')!;
    const pbs = [
      playbook({ id: 'threat-a', category: 'Threat-informed' }),
      playbook({ id: 'threat-b', category: 'Threat-informed' }),
      playbook({ id: 'endurance', category: 'Endurance' }),
    ];
    const { suite } = templatesForObjective(threat, pbs);
    expect(suite.map((t) => t.id)).toEqual(['threat-a', 'threat-b']);
  });
});

describe('template metrics', () => {
  it('sums duration/requests across playbook steps and takes the peak rps', () => {
    const t = {
      kind: 'playbook' as const,
      id: 'x',
      playbook: playbook({
        steps: [
          step({ maxRps: 100, maxDurationSec: 120, profile: 'constant' }),
          step({ maxRps: 800, maxDurationSec: 180, profile: 'wave' }),
        ],
      }),
    };
    expect(peakRps(t)).toBe(800);
    expect(totalDurationSec(t)).toBe(300);
    expect(estRequests(t)).toBeGreaterThan(0);
  });

  it('withinCaps / capBreach flag a template above the effective limit', () => {
    const tight: HardCaps = { maxRps: 200, maxConcurrency: 500, maxDurationSec: 900 };
    const t = {
      kind: 'playbook' as const,
      id: 'x',
      playbook: playbook({ steps: [step({ maxRps: 500 })] }),
    };
    expect(withinCaps(t, CAPS)).toBe(true);
    expect(withinCaps(t, tight)).toBe(false);
    expect(capBreach(t, tight)).toMatch(/peak 500 rps > limit 200/);
  });
});

describe('recommendTemplate', () => {
  const threat = getObjective('threat')!;
  const templates = () =>
    templatesForObjective(threat, [
      playbook({ id: 'threat-lo', drsLevel: 3, steps: [step({ maxRps: 300 })] }),
      playbook({ id: 'threat-hi', drsLevel: 5, steps: [step({ maxRps: 700 })] }),
    ]);

  it('recommends the gentlest scenario on a first (history-less) run', () => {
    const ctx: RecoContext = { engines, caps: CAPS, lastWrs: null };
    const { pick, reason } = recommendTemplate(threat, templates(), ctx);
    expect(pick?.id).toBe('threat-lo');
    expect(reason).toMatch(/first run/i);
  });

  it('steps up when the last score was strong', () => {
    const ctx: RecoContext = {
      engines,
      caps: CAPS,
      lastWrs: { wrs: 92, level: 'A', regression: false },
    };
    const { pick, reason } = recommendTemplate(threat, templates(), ctx);
    expect(pick?.id).toBe('threat-hi');
    expect(reason).toMatch(/step up/i);
  });

  it('re-baselines on a detected regression', () => {
    const cap = getObjective('capacity')!;
    const t = templatesForObjective(cap, [playbook({ id: 'capacity-assessment' })]);
    const ctx: RecoContext = {
      engines,
      caps: CAPS,
      lastWrs: { wrs: 70, level: 'C', regression: true },
    };
    const { pick, reason } = recommendTemplate(cap, t, ctx);
    expect(pick?.kind === 'preset' && pick.preset.id).toBe('baseline');
    expect(reason).toMatch(/regression/i);
  });

  it('never recommends a template that breaches the effective caps', () => {
    const tight: HardCaps = { maxRps: 400, maxConcurrency: 500, maxDurationSec: 900 };
    const ctx: RecoContext = {
      engines,
      caps: tight,
      lastWrs: { wrs: 92, level: 'A', regression: false },
    };
    const { pick } = recommendTemplate(threat, templates(), ctx);
    // threat-hi peaks at 700 > 400 → excluded; only threat-lo (300) remains.
    expect(pick?.id).toBe('threat-lo');
  });
});

describe('lastWrsFor', () => {
  const series: WrsSeries[] = [
    {
      target: 'staging.example.com',
      points: [
        { at: '2026-01-01T00:00:00Z', wrs: 80, level: 'B', runId: 'r1' },
        { at: '2026-01-02T00:00:00Z', wrs: 91, level: 'A', runId: 'r2' },
      ],
      regression: false,
      drop: 0,
    },
  ];

  it('resolves the latest point by hostname from a full URL', () => {
    expect(lastWrsFor('https://staging.example.com/', series)).toMatchObject({
      wrs: 91,
      level: 'A',
    });
    expect(lastWrsFor('https://unknown.host/', series)).toBeNull();
  });
});
