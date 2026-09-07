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

  it('applies an optional recurrence to every campaign of the suite', () => {
    const inputs = buildSuiteCampaigns(
      getPlaybook('quick-readiness')!,
      { ...target, recurrenceMin: 360 },
      engines,
    );
    expect(inputs.every((c) => c.recurrence?.intervalMin === 360)).toBe(true);
    const once = buildSuiteCampaigns(getPlaybook('quick-readiness')!, target, engines);
    expect(once.every((c) => c.recurrence === undefined)).toBe(true);
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

describe('threat-informed playbooks', () => {
  it('carry threat metadata (reference, notReproduced)', () => {
    const pb = getPlaybook('threat-l7-signature-evasion')!;
    expect(pb.threat).toBeDefined();
    expect(pb.threat!.reference).toMatch(/./);
    expect(pb.threat!.notReproduced).toMatch(/./);
  });

  it('resolve paths to a same-origin endpoint mix and rotate UA (built-in only)', () => {
    const inputs = buildSuiteCampaigns(
      getPlaybook('threat-l7-signature-evasion')!,
      target,
      engines,
    );
    const wave = inputs.find((i) => i.name.includes('Evasion wave'))!;
    expect(wave.agent).toBe('builtin');
    expect(wave.endpoints?.length).toBe(5);
    expect(wave.endpoints!.every((e) => e.url.startsWith('https://staging.example.com'))).toBe(
      true,
    );
    expect(wave.userAgents?.length).toBeGreaterThan(1);
  });

  it('every threat-informed campaign passes createCampaign validation', () => {
    for (const pb of PLAYBOOKS.filter((p) => p.threat)) {
      for (const input of buildSuiteCampaigns(pb, target, engines)) {
        const c = createCampaign(input, allowed, [
          { id: 'builtin', multiPhase: true, flowCapable: true, correlationCapable: true },
          { id: 'k6', multiPhase: true, flowCapable: true, correlationCapable: false },
        ]);
        expect(c.status).toBe('PENDING_APPROVAL');
      }
    }
  });

  it('URL-allowlist probe spreads over non-existent paths (bounded 404 test)', () => {
    const pb = getPlaybook('threat-url-allowlist')!;
    expect(pb.threat!.reference).toMatch(/random_flood/);
    const wave = buildSuiteCampaigns(pb, target, engines).find((i) =>
      i.name.includes('Random-URL'),
    )!;
    expect(wave.vector).toBe('http-get');
    expect(
      wave.endpoints!.every((e) =>
        /example\.com\/(nonexistent|no\/such|api\/does-not|\.well-known|random-)/.test(e.url),
      ),
    ).toBe(true);
  });

  it('method-policy playbook emits a bounded POST step (GET baseline default)', () => {
    const inputs = buildSuiteCampaigns(getPlaybook('threat-method-policy')!, target, engines);
    const baseline = inputs.find((i) => i.name.includes('Baseline'))!;
    const post = inputs.find((i) => i.name.includes('POST wave'))!;
    expect(baseline.vector).toBe('http-get'); // default
    expect(post.vector).toBe('http-post'); // step vector honoured
  });
});

describe('playbook step vector validation', () => {
  const step = (extra: Record<string, unknown>) => ({
    name: 'S',
    maxRps: 50,
    concurrency: 10,
    maxDurationSec: 60,
    profile: 'constant',
    ...extra,
  });

  it('defaults to http-get and preserves an explicit http-post', () => {
    expect(validatePlaybookInput({ name: 'x', steps: [step({})] }).steps[0].vector).toBe(
      'http-get',
    );
    expect(
      validatePlaybookInput({ name: 'x', steps: [step({ vector: 'http-post' })] }).steps[0].vector,
    ).toBe('http-post');
  });

  it('rejects an unsupported vector (no PUT / flood vectors)', () => {
    expect(() =>
      validatePlaybookInput({ name: 'x', steps: [step({ vector: 'http-put' })] }),
    ).toThrow(/vector/);
  });
});

describe('DRS levels & the expanded threat catalogue', () => {
  const NEW_IDS = [
    'threat-l7-multivector',
    'threat-iot-botnet',
    'threat-ramp-plateau',
    'threat-sync-pulse',
    'threat-chaos',
  ];

  it('ships the five new bounded threat scenarios', () => {
    for (const id of NEW_IDS) expect(getPlaybook(id), id).toBeDefined();
  });

  it('every threat-informed playbook carries a DRS level (3–5) and threat metadata', () => {
    for (const pb of PLAYBOOKS.filter((p) => p.threat)) {
      expect(pb.drsLevel, pb.id).toBeGreaterThanOrEqual(3);
      expect(pb.drsLevel!, pb.id).toBeLessThanOrEqual(5);
      expect(pb.threat!.reference.trim(), pb.id).not.toBe('');
      expect(pb.threat!.notReproduced.trim(), pb.id).not.toBe('');
    }
  });

  it('the new scenarios cite the zeroBS reference they approximate', () => {
    for (const id of NEW_IDS) {
      expect(getPlaybook(id)!.threat!.reference, id).toMatch(/zeroBS/);
    }
  });

  it('every step of every curated playbook stays within HARD_CAPS', () => {
    for (const pb of PLAYBOOKS) {
      for (const s of pb.steps) {
        expect(s.maxRps, pb.id).toBeLessThanOrEqual(2000);
        expect(s.concurrency, pb.id).toBeLessThanOrEqual(500);
        expect(s.maxDurationSec, pb.id).toBeLessThanOrEqual(900);
      }
    }
  });

  it('validates a custom drsLevel and rejects out-of-range', () => {
    const ok = validatePlaybookInput({
      name: 'x',
      drsLevel: 4,
      steps: [{ maxRps: 50, concurrency: 10, maxDurationSec: 60, profile: 'constant' }],
    });
    expect(ok.drsLevel).toBe(4);
    expect(() =>
      validatePlaybookInput({
        name: 'x',
        drsLevel: 9,
        steps: [{ maxRps: 50, concurrency: 10, maxDurationSec: 60, profile: 'constant' }],
      }),
    ).toThrow(/drsLevel/);
  });
});
