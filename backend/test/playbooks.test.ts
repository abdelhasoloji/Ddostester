import { describe, expect, it } from 'vitest';
import {
  PLAYBOOKS,
  PlaybookError,
  buildScenario,
  buildSuiteCampaigns,
  getPlaybook,
  validatePlaybookInput,
} from '../src/modules/playbooks/playbooks.js';
import { createCampaign } from '../src/modules/campaigns/service.js';

const allowed = ['staging.example.com'];
const target = {
  target: 'https://staging.example.com/',
  probeUrl: 'https://staging.example.com/health',
  createdBy: 'eng@wedos',
};
const engines = [
  { id: 'builtin', available: true },
  { id: 'k6', available: true },
  { id: 'vegeta', available: false },
];

describe('playbooks', () => {
  it('exposes curated playbooks with ordered steps', () => {
    expect(PLAYBOOKS.length).toBeGreaterThanOrEqual(3);
    expect(getPlaybook('capacity-assessment')?.steps.length).toBe(3);
    expect(getPlaybook('nope')).toBeUndefined();
  });

  it('buildScenario returns bounded phases for ramp/wave and none for constant', () => {
    expect(buildScenario('constant', 100, 60)).toBeUndefined();
    expect(buildScenario('ramp', 300, 180)).toHaveLength(3);
    const wave = buildScenario('wave', 500, 180)!;
    expect(wave[0].maxRps).toBeGreaterThan(wave[1].maxRps);
  });

  it('builds a linked suite of campaign inputs', () => {
    const inputs = buildSuiteCampaigns(getPlaybook('capacity-assessment')!, target, engines);
    expect(inputs).toHaveLength(3);
    const suiteId = inputs[0].suiteId;
    expect(suiteId).toBeTruthy();
    expect(inputs.every((c) => c.suiteId === suiteId)).toBe(true);
    expect(inputs.map((c) => c.suiteOrder)).toEqual([0, 1, 2]);
    expect(inputs.every((c) => c.target === target.target)).toBe(true);
  });

  it('only assigns an engine that is installed (else server default)', () => {
    const inputs = buildSuiteCampaigns(getPlaybook('capacity-assessment')!, target, engines);
    // steps prefer vegeta (unavailable) and k6 (available)
    const ramp = inputs.find((c) => c.name.includes('Ramp'))!;
    expect(ramp.agent).toBe('k6');
    const baseline = inputs.find((c) => c.name.includes('Baseline'))!;
    expect(baseline.agent).toBeUndefined(); // vegeta not installed → server default
  });

  it('validatePlaybookInput accepts a valid custom playbook and marks it custom', () => {
    const pb = validatePlaybookInput({
      name: 'My assessment',
      steps: [
        { name: 'Warm', maxRps: 50, concurrency: 10, maxDurationSec: 60, profile: 'constant' },
      ],
    });
    expect(pb.custom).toBe(true);
    expect(pb.id.startsWith('custom-')).toBe(true);
    expect(pb.steps).toHaveLength(1);
  });

  it('validatePlaybookInput rejects a name-less playbook, no steps, and over-cap steps', () => {
    expect(() =>
      validatePlaybookInput({ steps: [{ maxRps: 1, concurrency: 1, maxDurationSec: 1 }] }),
    ).toThrow(PlaybookError);
    expect(() => validatePlaybookInput({ name: 'x', steps: [] })).toThrow(PlaybookError);
    expect(() =>
      validatePlaybookInput({
        name: 'x',
        steps: [{ maxRps: 999999, concurrency: 10, maxDurationSec: 60, profile: 'constant' }],
      }),
    ).toThrow(/maxRps/);
  });

  it('produces campaigns that pass createCampaign validation (PENDING_APPROVAL)', () => {
    const inputs = buildSuiteCampaigns(getPlaybook('quick-readiness')!, target, engines);
    for (const input of inputs) {
      const c = createCampaign(input, allowed, [
        { id: 'builtin', multiPhase: true, flowCapable: true, correlationCapable: true },
        { id: 'k6', multiPhase: true, flowCapable: true, correlationCapable: false },
      ]);
      expect(c.status).toBe('PENDING_APPROVAL');
      expect(c.suiteName).toBe('Quick readiness check');
    }
  });
});
