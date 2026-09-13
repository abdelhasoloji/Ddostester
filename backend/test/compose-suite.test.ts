import { describe, it, expect } from 'vitest';
import {
  PLAYBOOKS,
  buildCompositeSuite,
  isBaselineStep,
} from '../src/modules/playbooks/playbooks.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { HARD_CAPS } from '../src/config/limits.js';

// buildCompositeSuite composes several templates into ONE suite: their steps
// are concatenated in template order under a single suiteId, so the result
// behaves like any other suite (sequencer, aggregate WRS, one report). This
// exercises exactly what POST /api/suites/compose runs before createCampaign.
const TARGET = 'https://bank.cz';
const ALLOWED = ['bank.cz'];
const ENGINES = [
  { id: 'builtin', available: true },
  { id: 'vegeta', available: true },
  { id: 'k6', available: true },
];
const AGENTS = [
  {
    id: 'builtin',
    multiPhase: true,
    flowCapable: true,
    endpointCapable: true,
    correlationCapable: true,
  },
  {
    id: 'vegeta',
    multiPhase: true,
    flowCapable: false,
    endpointCapable: true,
    correlationCapable: false,
  },
  {
    id: 'k6',
    multiPhase: true,
    flowCapable: true,
    endpointCapable: true,
    correlationCapable: false,
  },
];

const multiStep = PLAYBOOKS.filter((p) => p.steps.length > 1);
const singleStep = PLAYBOOKS.filter((p) => p.steps.length === 1);

describe('buildCompositeSuite', () => {
  it('dedupes baselines across the composite (keeps the first, contiguous order)', () => {
    const step = (name: string) => ({
      name,
      summary: '',
      maxRps: 100,
      concurrency: 20,
      maxDurationSec: 60,
      profile: 'constant' as const,
    });
    const pb = (id: string, steps: ReturnType<typeof step>[]) =>
      ({ id, name: id.toUpperCase(), category: 'x', summary: '', when: '', steps }) as never;
    const pbs = [
      pb('a', [step('Baseline'), step('Wave A')]),
      pb('b', [step('Baseline'), step('Wave B')]),
      pb('c', [step('Baseline')]),
    ];
    const inputs = buildCompositeSuite(
      pbs,
      'mix',
      { target: TARGET, probeUrl: TARGET, createdBy: 'x' },
      ENGINES,
    );
    // One baseline survives (A's); B's and C's are dropped. Both waves stay.
    expect(inputs.filter((i) => /baseline/i.test(i.name))).toHaveLength(1);
    expect(inputs.filter((i) => /Wave/.test(i.name))).toHaveLength(2);
    expect(inputs).toHaveLength(3);
    expect(inputs.map((i) => i.suiteOrder)).toEqual([0, 1, 2]);
  });

  it('concatenates the steps of several templates under one suite', () => {
    const picks = [multiStep[0], singleStep[0], multiStep[1]].filter(Boolean);
    const total = picks.reduce((n, p) => n + p.steps.length, 0);
    // Baselines are deduped across the composite (keep the first).
    const baselineCount = picks.reduce((n, p) => n + p.steps.filter(isBaselineStep).length, 0);
    const expected = total - Math.max(0, baselineCount - 1);
    const inputs = buildCompositeSuite(
      picks,
      'My mix',
      { target: TARGET, probeUrl: TARGET, createdBy: 'test' },
      ENGINES,
    );

    // One campaign per source step, minus the deduped baselines, in template order.
    expect(inputs.length).toBe(expected);
    // A single shared suiteId, and the suiteName is the composite's own.
    const suiteIds = new Set(inputs.map((i) => i.suiteId));
    expect(suiteIds.size).toBe(1);
    expect(inputs.every((i) => i.suiteName === 'My mix')).toBe(true);
    // suiteOrder is a contiguous 0..n-1 running index across all templates.
    expect(inputs.map((i) => i.suiteOrder)).toEqual([...Array(expected).keys()]);
  });

  it('keeps the source template visible in each step name', () => {
    const a = multiStep[0];
    const b = singleStep[0];
    const inputs = buildCompositeSuite(
      [a, b],
      'Mix',
      { target: TARGET, probeUrl: TARGET, createdBy: 'test' },
      ENGINES,
    );
    // Multi-step template → "<template> — <step>"; single-step → just its name.
    expect(inputs[0].name.startsWith(`${a.name} — `)).toBe(true);
    expect(inputs[inputs.length - 1].name).toBe(b.name);
  });

  it('produces only valid, in-caps campaigns (production creation gate)', () => {
    const picks = [multiStep[0], multiStep[1]].filter(Boolean);
    const inputs = buildCompositeSuite(
      picks,
      'Mix',
      { target: TARGET, probeUrl: TARGET, createdBy: 'test' },
      ENGINES,
    );
    inputs.forEach((input, i) => {
      const c = createCampaign(input, ALLOWED, AGENTS, HARD_CAPS);
      expect(c.maxRps, `step ${i}: maxRps`).toBeLessThanOrEqual(HARD_CAPS.maxRps);
      expect(c.concurrency, `step ${i}: concurrency`).toBeLessThanOrEqual(HARD_CAPS.maxConcurrency);
      expect(c.maxDurationSec, `step ${i}: duration`).toBeLessThanOrEqual(HARD_CAPS.maxDurationSec);
      expect(new URL(c.target).host).toBe('bank.cz');
      expect(c.suiteOrder).toBe(i);
    });
  });
});
