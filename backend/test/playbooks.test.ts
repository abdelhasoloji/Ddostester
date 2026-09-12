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
import { HARD_CAPS } from '../src/config/limits.js';

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

  it('ships the P26-20371 L7 pre-test playbook, ordered DRS 3→5 and within caps', () => {
    const pb = getPlaybook('pretest-cra-l7');
    expect(pb).toBeTruthy();
    expect(pb!.drsLevel).toBe(5);
    // Every step stays inside the immutable ceiling (bounded, no widening).
    for (const s of pb!.steps) {
      expect(s.maxRps).toBeGreaterThan(0);
      expect(s.maxRps).toBeLessThanOrEqual(HARD_CAPS.maxRps);
      expect(s.concurrency).toBeLessThanOrEqual(HARD_CAPS.maxConcurrency);
      expect(s.maxDurationSec).toBeLessThanOrEqual(HARD_CAPS.maxDurationSec);
    }
    // It instantiates into one bounded campaign per line, all on the given target.
    const inputs = buildSuiteCampaigns(pb!, target, engines);
    expect(inputs.length).toBe(pb!.steps.length);
    expect(inputs.every((c) => c.target === target.target)).toBe(true);
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
    // A custom template is stamped with a creation date.
    expect(pb.createdAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(pb.createdAt!))).toBe(false);
  });

  it('every curated template carries a valid createdAt date', () => {
    const curated = PLAYBOOKS.filter((p) => !p.custom);
    expect(curated.length).toBeGreaterThan(0);
    for (const pb of curated) {
      expect(pb.createdAt, `${pb.id} createdAt`).toBeTruthy();
      expect(Number.isNaN(Date.parse(pb.createdAt!)), `${pb.id} parseable`).toBe(false);
    }
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

  it('accepts custom string headers and rejects non-string / too many', () => {
    const ok = validatePlaybookInput({
      name: 'x',
      steps: [step({ headers: { 'Accept-Language': 'cs-CZ', 'X-App': 'mobile' } })],
    });
    expect(ok.steps[0].headers).toEqual({ 'Accept-Language': 'cs-CZ', 'X-App': 'mobile' });
    expect(() =>
      validatePlaybookInput({ name: 'x', steps: [step({ headers: { A: 1 } })] }),
    ).toThrow(/header/);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`H${i}`, 'v']));
    expect(() => validatePlaybookInput({ name: 'x', steps: [step({ headers: many })] })).toThrow(
      /headers/,
    );
  });

  it('header-fingerprint playbook carries custom headers into its wave step', () => {
    const pb = getPlaybook('threat-header-fingerprint')!;
    expect(pb.drsLevel).toBe(4);
    const wave = buildSuiteCampaigns(pb, target, engines).find((i) =>
      i.name.includes('Fingerprint wave'),
    )!;
    expect(wave.headers).toMatchObject({ 'Accept-Language': expect.any(String) });
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

  it('ships the three newest (2024–2025) bounded L7-trend scenarios at DRS 5', () => {
    for (const id of ['threat-http2-continuation', 'threat-madeyoureset', 'threat-aisuru-botnet']) {
      const pb = getPlaybook(id);
      expect(pb, id).toBeDefined();
      expect(pb!.drsLevel, id).toBe(5);
      // Each documents the harmful mechanism it deliberately does NOT reproduce.
      expect(pb!.threat!.notReproduced.trim(), id).not.toBe('');
    }
  });

  it('continuation-flood scenario carries a bounded (≤10) benign header block', () => {
    const pb = getPlaybook('threat-http2-continuation')!;
    expect(pb.threat!.reference).toMatch(/CONTINUATION/i);
    const wave = buildSuiteCampaigns(pb, target, engines).find((i) =>
      i.name.includes('Header-pressure'),
    )!;
    expect(wave.agent).toBe('builtin');
    expect(Object.keys(wave.headers ?? {}).length).toBeGreaterThan(1);
    expect(Object.keys(wave.headers ?? {}).length).toBeLessThanOrEqual(10);
    expect(wave.headers).toMatchObject({ Accept: expect.any(String) });
  });

  it('MadeYouReset scenario cites CVE-2025-8671 and stays a complete-request h2 burst', () => {
    const pb = getPlaybook('threat-madeyoureset')!;
    expect(pb.threat!.reference).toMatch(/CVE-2025-8671/);
    expect(pb.threat!.notReproduced).toMatch(/RST_STREAM|reset/i);
    const burst = buildSuiteCampaigns(pb, target, engines).find((i) =>
      i.name.endsWith('HTTP/2 burst'),
    )!;
    expect(burst.agent).toBe('k6'); // h2 negotiated by k6 on HTTPS
    expect(burst.vector).toBe('http-get');
  });

  it('Aisuru fan-out spreads over deep paths with rotating UA + headers, bounded', () => {
    const pb = getPlaybook('threat-aisuru-botnet')!;
    const wave = buildSuiteCampaigns(pb, target, engines).find((i) => i.name.includes('Fan-out'))!;
    expect(wave.endpoints!.length).toBeGreaterThanOrEqual(5);
    expect(wave.endpoints!.every((e) => e.url.startsWith('https://staging.example.com'))).toBe(
      true,
    );
    expect(wave.userAgents!.length).toBeGreaterThan(1);
    expect(wave.concurrency).toBeLessThanOrEqual(500); // never exceeds HARD_CAPS
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

describe('zeroBS L7 single-line playbooks (P26-20371)', () => {
  const singles = PLAYBOOKS.filter((p) => p.id.startsWith('cra-l7-'));
  const target = {
    target: 'https://staging.example.com/',
    probeUrl: 'https://staging.example.com/health',
    createdBy: 'e',
  };
  const engines = [{ id: 'builtin', available: true }];

  it('derives one single-step template per parent line', () => {
    const parent = getPlaybook('pretest-cra-l7')!;
    expect(singles).toHaveLength(parent.steps.length);
    for (const p of singles) {
      expect(p.steps).toHaveLength(1);
      expect(p.category).toBe('zeroBS L7 lines (P26-20371)');
    }
    // ids are unique across the whole library.
    expect(new Set(PLAYBOOKS.map((p) => p.id)).size).toBe(PLAYBOOKS.length);
  });

  it('each line is independently instantiable into exactly one campaign', () => {
    for (const p of singles) {
      const inputs = buildSuiteCampaigns(p, target, engines);
      expect(inputs).toHaveLength(1);
      // Single-step campaign is named after the playbook itself — no doubled
      // "<playbook> — <step>" suffix (the playbook name already carries the line).
      expect(inputs[0].name).toBe(p.name);
    }
  });

  it('preserves the SlowLoris vector and the random-flood realism', () => {
    const slow = buildSuiteCampaigns(getPlaybook('cra-l7-slowloris')!, target, engines)[0];
    expect(slow.vector).toBe('http-slowloris');
    expect(slow.maxRps).toBe(10);

    const rnd = buildSuiteCampaigns(getPlaybook('cra-l7-get-random-flood')!, target, engines)[0];
    expect(rnd.endpoints).toHaveLength(4); // relative paths resolved against the target
    expect(rnd.endpoints?.[0].url).toBe('https://staging.example.com/nonexistent-a1');
    expect(rnd.scenario).toHaveLength(3); // wave profile
  });
});

describe('bank.cz connexes playbook (adjacent-scenario hypotheses)', () => {
  const target = {
    target: 'https://staging.example.com/',
    probeUrl: 'https://staging.example.com/health',
    createdBy: 'e',
  };
  const engines = [{ id: 'builtin', available: true }];

  it('exists with the 8 adjacent lines and stays within HARD_CAPS', () => {
    const pb = getPlaybook('bankcz-connexes');
    expect(pb).toBeDefined();
    expect(pb!.steps).toHaveLength(8);
    for (const s of pb!.steps) {
      expect(s.maxRps).toBeLessThanOrEqual(HARD_CAPS.maxRps);
      expect(s.concurrency).toBeLessThanOrEqual(HARD_CAPS.maxConcurrency);
      expect(s.maxDurationSec).toBeLessThanOrEqual(HARD_CAPS.maxDurationSec);
    }
  });

  it('covers the two proven mechanisms: POST/dynamic and high concurrency', () => {
    const pb = getPlaybook('bankcz-connexes')!;
    // Mechanism A — several POST lines on dynamic/auth endpoints.
    expect(pb.steps.filter((s) => s.vector === 'http-post').length).toBeGreaterThanOrEqual(3);
    // Mechanism B — a high-concurrency hold beyond the THOR line's 250.
    expect(pb.steps.some((s) => s.concurrency >= 300)).toBe(true);
    // A bounded slow connection-hold line (no true SlowLoris abuse).
    expect(pb.steps.some((s) => s.vector === 'http-slowloris')).toBe(true);
  });

  it('instantiates the whole suite into governed campaigns', () => {
    const pb = getPlaybook('bankcz-connexes')!;
    const inputs = buildSuiteCampaigns(pb, target, engines);
    expect(inputs).toHaveLength(8);
    // Every instantiated line carries the target and stays a bounded vector.
    for (const c of inputs) {
      expect(c.target).toBe('https://staging.example.com/');
      expect(['http-get', 'http-post', 'http-slowloris']).toContain(c.vector);
    }
  });
});
