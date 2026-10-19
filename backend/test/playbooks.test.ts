import { describe, expect, it } from 'vitest';
import {
  PLAYBOOKS,
  PlaybookError,
  buildScenario,
  buildSuiteCampaigns,
  stepToCampaignSeed,
  seedPaths,
  getPlaybook,
  validatePlaybookInput,
} from '../src/modules/playbooks/playbooks.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { missingRequirements } from '../src/modules/campaigns/model.js';
import { HARD_CAPS } from '../src/config/limits.js';

const allowed = ['staging.example.com'];

it('preserves explicit target selection through validation and recon for the ZeroBS GET line', () => {
  const original = getPlaybook('cra-l7-get-flood')!;
  const validated = validatePlaybookInput(original);
  expect(validated.steps[0].focusDynamic).toBe(false);
  const [campaign] = buildSuiteCampaigns(
    validated,
    {
      target: 'https://staging.example.com/',
      probeUrl: 'https://staging.example.com/',
      createdBy: 'engineer',
      recon: { paths: ['/', '/api/slow'], dynamicPaths: ['/api/slow'] },
    },
    [{ id: 'vegeta', available: true }],
  );
  expect(campaign.target).toBe('https://staging.example.com/');
  expect(campaign.endpoints).toBeUndefined();
  expect(campaign.noKeepAlive).toBeUndefined();
  expect(campaign.concurrency).toBe(original.steps[0].concurrency);
});
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

  it('propagates the template requires + recon posture snapshot to every campaign', () => {
    const pb = getPlaybook('threat-http2-burst')!;
    expect(pb.requires).toContain('h2');
    const posture = { h2: false, waf: false, cache: false, dynamic: true } as const;
    const inputs = buildSuiteCampaigns(pb, { ...target, reconPosture: posture }, engines);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((c) => c.requires?.includes('h2'))).toBe(true);
    expect(inputs.every((c) => c.reconPosture === posture)).toBe(true);
    // A template with no requires leaves the field undefined.
    const cap = buildSuiteCampaigns(getPlaybook('capacity-assessment')!, target, engines);
    expect(cap.every((c) => c.requires === undefined)).toBe(true);
  });

  it('stepToCampaignSeed (no caps) equals a suite member minus its suite fields', () => {
    const pb = getPlaybook('capacity-assessment')!;
    const [member] = buildSuiteCampaigns(pb, target, engines);
    const seed = stepToCampaignSeed(pb.steps[0], {
      name: member.name,
      target: target.target,
      probeUrl: target.probeUrl,
      createdBy: target.createdBy,
      engines,
    });
    // The wrapper only re-adds suiteId/suiteName/suiteOrder.
    const { suiteId: _s, suiteName: _n, suiteOrder: _o, ...memberCore } = member;
    void [_s, _n, _o];
    expect(seed).toEqual(memberCore);
    expect(seed).not.toHaveProperty('suiteId');
  });

  it('stepToCampaignSeed clamps to caps when given (recommender path)', () => {
    const pb = getPlaybook('capacity-assessment')!;
    const peak = pb.steps.reduce((a, b) => (b.maxRps > a.maxRps ? b : a));
    const caps = { maxRps: 25, maxConcurrency: 10, maxDurationSec: 20 };
    const seed = stepToCampaignSeed(peak, {
      name: 'clamped',
      target: target.target,
      probeUrl: target.probeUrl,
      createdBy: target.createdBy,
      engines,
      caps,
    });
    expect(seed.maxRps).toBeLessThanOrEqual(caps.maxRps);
    expect(seed.concurrency).toBeLessThanOrEqual(caps.maxConcurrency);
    expect(seed.maxDurationSec).toBeLessThanOrEqual(caps.maxDurationSec);
    const total = (seed.scenario ?? []).reduce((n, p) => n + p.durationSec, 0);
    expect(total).toBeLessThanOrEqual(caps.maxDurationSec);
  });

  it('threat-informed templates carry a clickable public source link', () => {
    const threatTemplates = PLAYBOOKS.filter((p) => p.threat);
    expect(threatTemplates.length).toBeGreaterThan(5);
    // The key patterns we validated live are sourced to authoritative references.
    const sourced = threatTemplates.filter((p) => p.threat?.source);
    expect(sourced.length).toBeGreaterThanOrEqual(10);
    for (const p of sourced) expect(p.threat!.source).toMatch(/^https:\/\//);
    // A specific mapping: the HTTP/2 CONTINUATION line points at the CERT note.
    const cont = PLAYBOOKS.find((p) => p.id === 'threat-http2-continuation');
    expect(cont?.threat?.source).toContain('kb.cert.org');
    // The JA4 fingerprint line points at the JA4 project.
    const ja4 = PLAYBOOKS.find((p) => p.id === 'threat-ivan-ja4-sweep');
    expect(ja4?.threat?.source).toContain('FoxIO-LLC/ja4');
  });

  it('missingRequirements returns the features a target lacks (N/A), else empty', () => {
    const posture = { h2: false, waf: true, cache: false, dynamic: true };
    expect(missingRequirements(['h2', 'waf'], posture)).toEqual(['h2']);
    expect(missingRequirements(['waf', 'dynamic'], posture)).toEqual([]);
    // No requires or no posture → nothing is N/A.
    expect(missingRequirements(undefined, posture)).toEqual([]);
    expect(missingRequirements(['h2'], undefined)).toEqual([]);
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

  it('rejects an empty, blank or oversized explicit User-Agent set', () => {
    const step = { maxRps: 1, concurrency: 1, maxDurationSec: 10, profile: 'constant' as const };
    for (const userAgents of [[], [''], ['  '], Array.from({ length: 51 }, (_, i) => 'ua' + i)])
      expect(() => validatePlaybookInput({ name: 'x', steps: [{ ...step, userAgents }] })).toThrow(
        PlaybookError,
      );
    expect(() =>
      validatePlaybookInput({ name: 'x', steps: [{ ...step, userAgents: ['curl/8.6.0'] }] }),
    ).not.toThrow();
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
        {
          id: 'builtin',
          multiPhase: true,
          flowCapable: true,
          endpointCapable: true,
          correlationCapable: true,
        },
        {
          id: 'k6',
          multiPhase: true,
          flowCapable: true,
          endpointCapable: true,
          correlationCapable: false,
        },
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

  it('ships a cache-busted L7 pattern with UA rotation and a POST step', () => {
    const pb = getPlaybook('threat-l7-cache-busted-flood')!;
    expect(pb).toBeTruthy();
    expect(pb.category).toBe('Threat-informed');
    expect(pb.requires).toEqual(expect.arrayContaining(['waf', 'cache']));
    const wave = pb.steps.find((step) => step.name.includes('Cache-busted'))!;
    expect(wave).toMatchObject({ cacheBust: true, rotateUa: true, profile: 'wave' });
    expect(wave.paths!.length).toBeGreaterThanOrEqual(5);
    expect(wave.headers?.['accept-language']).toBeTruthy();
    const post = pb.steps.find((step) => step.vector === 'http-post')!;
    expect(post.cacheBust).toBe(true);
    for (const step of pb.steps) {
      expect(step.maxRps).toBeLessThanOrEqual(HARD_CAPS.maxRps);
      expect(step.maxDurationSec).toBeLessThanOrEqual(HARD_CAPS.maxDurationSec);
    }
    // The template must state what it deliberately does not reproduce.
    expect(pb.threat!.notReproduced).toMatch(/spoof/i);
    expect(pb.threat!.notReproduced).toMatch(/botnet/i);
  });

  it('keeps step headers and explicit UA sets when vegeta is the engine', () => {
    // The default fixture marks vegeta unavailable, which falls back to builtin and
    // used to hide the header gate. This case pins vegeta as available.
    const withVegeta = [
      { id: 'builtin', available: true },
      { id: 'vegeta', available: true },
      { id: 'k6', available: true },
    ];
    const inputs = buildSuiteCampaigns(
      getPlaybook('threat-l7-cache-busted-flood')!,
      target,
      withVegeta,
    );
    const wave = inputs.find((input) => input.name.includes('Cache-busted'))!;
    expect(wave.agent).toBe('vegeta');
    expect(wave.headers?.['accept-language']).toBe('en-US,en;q=0.9');
    expect(wave.userAgents?.length).toBeGreaterThan(1);
    const clients = inputs.find((input) => input.name.includes('Non-browser'))!;
    expect(clients.userAgents).toEqual(
      expect.arrayContaining(['curl/8.6.0', 'python-requests/2.32.3']),
    );
    expect(clients.userAgents!.length).toBeGreaterThan(5);
  });

  it('resolves the cache-busted wave into bounded endpoints and a rotating UA set', () => {
    const inputs = buildSuiteCampaigns(
      getPlaybook('threat-l7-cache-busted-flood')!,
      target,
      engines,
    );
    const wave = inputs.find((input) => input.name.includes('Cache-busted'))!;
    expect(wave.endpoints?.length).toBe(5);
    expect(wave.userAgents?.length).toBeGreaterThan(1);
    expect(wave.cacheBust).toBe(true);
    expect(wave.headers?.['accept']).toContain('text/html');
  });

  it('marks the DRS5 composite lines for closed-loop rate calibration (GEN-1)', () => {
    const inputs = buildSuiteCampaigns(getPlaybook('pretest-cra-l7')!, target, engines);
    const byName = (frag: string) => inputs.find((i) => i.name.includes(frag))!;
    // The three high-rate composites/pulse whose configured rate may exceed a
    // single box's throughput are calibrated so their verdict is valid, not an
    // under-delivered inconclusive.
    expect(byName('MultiVector').calibrate).toBe(true);
    expect(byName('THOR').calibrate).toBe(true);
    expect(byName('MultiTarget').calibrate).toBe(true);
    // A plain single-vector line is NOT calibrated (it already delivers its rate).
    expect(byName('GET-Flood').calibrate).toBeFalsy();
  });

  it('flows a step-level calibrate flag through instantiation to the campaign input', () => {
    const pb = validatePlaybookInput({
      name: 'calib-step',
      steps: [
        {
          name: 'calibrated line',
          maxRps: 800,
          concurrency: 100,
          maxDurationSec: 60,
          profile: 'constant',
          calibrate: true,
        },
      ],
    });
    expect(pb.steps[0].calibrate).toBe(true);
    const [input] = buildSuiteCampaigns(pb, target, engines);
    expect(input.calibrate).toBe(true);
  });

  it('attaches the UA rotation set to a vegeta-resolved step (vegeta rotates UAs now)', () => {
    // The DRS5 composite fix: UA rotation is no longer built-in-only. A step that
    // resolves to vegeta must still carry its userAgents so vegeta can spread them
    // across its targets file — otherwise the line silently loses UA rotation.
    const pb = validatePlaybookInput({
      name: 'ua-on-vegeta',
      steps: [
        {
          name: 'rotate on vegeta',
          maxRps: 400,
          concurrency: 50,
          maxDurationSec: 60,
          profile: 'constant',
          agent: 'vegeta',
          rotateUa: true,
        },
      ],
    });
    const withVegeta = [{ id: 'vegeta', available: true }];
    const [input] = buildSuiteCampaigns(pb, target, withVegeta);
    expect(input.agent).toBe('vegeta');
    expect(input.userAgents?.length).toBeGreaterThan(1);
    // A k6-resolved step, by contrast, drops UA rotation (k6 doesn't rotate yet).
    const pbK6 = validatePlaybookInput({
      name: 'ua-on-k6',
      steps: [
        {
          name: 'rotate on k6',
          maxRps: 400,
          concurrency: 50,
          maxDurationSec: 60,
          profile: 'constant',
          agent: 'k6',
          rotateUa: true,
        },
      ],
    });
    const [k6Input] = buildSuiteCampaigns(pbK6, target, [{ id: 'k6', available: true }]);
    expect(k6Input.agent).toBe('k6');
    expect(k6Input.userAgents).toBeUndefined();
  });

  it('every threat-informed campaign passes createCampaign validation', () => {
    for (const pb of PLAYBOOKS.filter((p) => p.threat)) {
      for (const input of buildSuiteCampaigns(pb, target, engines)) {
        const c = createCampaign(input, allowed, [
          {
            id: 'builtin',
            multiPhase: true,
            flowCapable: true,
            endpointCapable: true,
            correlationCapable: true,
          },
          {
            id: 'k6',
            multiPhase: true,
            flowCapable: true,
            endpointCapable: true,
            correlationCapable: false,
          },
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

  it('accepts the delivery levers (cacheBust, noKeepAlive, parallelism) on a step', () => {
    const pb = validatePlaybookInput({
      name: 'x',
      steps: [step({ cacheBust: true, noKeepAlive: true, parallelism: 4 })],
    });
    expect(pb.steps[0]).toMatchObject({ cacheBust: true, noKeepAlive: true, parallelism: 4 });
    // Absent/false levers stay undefined (not persisted), and parallelism 1 is a no-op.
    const bare = validatePlaybookInput({ name: 'x', steps: [step({ parallelism: 1 })] });
    expect(bare.steps[0].cacheBust).toBeUndefined();
    expect(bare.steps[0].noKeepAlive).toBeUndefined();
    expect(bare.steps[0].parallelism).toBeUndefined();
  });

  it('rejects a parallelism outside [1, 8]', () => {
    expect(() => validatePlaybookInput({ name: 'x', steps: [step({ parallelism: 9 })] })).toThrow(
      /parallelism/,
    );
    expect(() => validatePlaybookInput({ name: 'x', steps: [step({ parallelism: 2.5 })] })).toThrow(
      /parallelism/,
    );
  });
});

describe('bank.cz breaker playbook', () => {
  it('stages a paired GET control vs. cache-bypass and a levers-on POST breaker (last)', () => {
    const pb = getPlaybook('bankcz-breaker')!;
    expect(pb).toBeTruthy();
    expect(pb.drsLevel).toBe(5);
    const inputs = buildSuiteCampaigns(pb, target, engines);
    // Ordered escalation: baseline → GET control → GET cache-bypass → POST breaker (last).
    const control = inputs.find((i) => i.name.includes('GET control'))!;
    const bypass = inputs.find((i) => i.name.includes('cache-bypass'))!;
    const breaker = inputs[inputs.length - 1];
    // Control carries no levers (the "before" of the delta).
    expect(control.cacheBust).toBeUndefined();
    expect(control.noKeepAlive).toBeUndefined();
    // Cache-bypass turns on every delivery lever at the SAME rate as the control.
    expect(bypass.maxRps).toBe(control.maxRps);
    expect(bypass).toMatchObject({ cacheBust: true, noKeepAlive: true, parallelism: 3 });
    // The breaker is the last step: POST, dynamic endpoints, all levers on.
    expect(breaker.name).toMatch(/breaker/i);
    expect(breaker.vector).toBe('http-post');
    expect(breaker).toMatchObject({ cacheBust: true, noKeepAlive: true, parallelism: 4 });
    // Every step stays within the immutable ceiling.
    for (const s of pb.steps) {
      expect(s.maxRps).toBeLessThanOrEqual(HARD_CAPS.maxRps);
      expect(s.concurrency).toBeLessThanOrEqual(HARD_CAPS.maxConcurrency);
      expect(s.maxDurationSec).toBeLessThanOrEqual(HARD_CAPS.maxDurationSec);
    }
  });

  it('breaker campaigns pass createCampaign validation', () => {
    const inputs = buildSuiteCampaigns(getPlaybook('bankcz-breaker')!, target, engines);
    for (const input of inputs) {
      const c = createCampaign(input, allowed, [
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
      ]);
      expect(c.status).toBe('PENDING_APPROVAL');
    }
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

  it('the new scenarios cite the DRS reference they approximate', () => {
    for (const id of NEW_IDS) {
      expect(getPlaybook(id)!.threat!.reference, id).toMatch(/DRS/);
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

describe('DRS L7 single-line playbooks (P26-20371)', () => {
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
      expect(p.category).toBe('DRS L7 lines (P26-20371)');
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

describe('seedPaths (recon-seeded endpoints)', () => {
  it('returns paths unchanged when no recon surface is supplied', () => {
    expect(seedPaths(['/search?q=x'], undefined)).toEqual(['/search?q=x']);
    expect(seedPaths(undefined, { paths: ['/'] })).toBeUndefined();
  });

  it('keeps on-surface paths and drops off-surface ones', () => {
    const out = seedPaths(['/search?q=alpha', '/ghost', '/nope'], {
      paths: ['/', '/search', '/about'],
    });
    expect(out).toEqual(['/search?q=alpha']); // /ghost, /nope dropped (would 404)
  });

  it('substitutes the discovered login path for auth-intent paths', () => {
    const out = seedPaths(['/login', '/account', '/contact'], {
      paths: ['/', '/contact'],
      loginPath: '/realms/srp/account',
    });
    // /login + /account → the real login path (deduped); /contact kept (on surface).
    expect(out).toEqual(['/realms/srp/account', '/contact']);
  });

  it('falls back to the root when nothing matches (never floods 404s)', () => {
    expect(seedPaths(['/ghost', '/nope'], { paths: ['/', '/health'] })).toEqual(['/']);
  });

  it('threads recon through buildSuiteCampaigns into the resolved endpoints', () => {
    const pb = getPlaybook('bankcz-connexes')!;
    const inputs = buildSuiteCampaigns(
      pb,
      {
        target: 'https://bank.cz/',
        probeUrl: 'https://bank.cz/',
        createdBy: 'e',
        recon: { paths: ['/', '/search'], loginPath: '/account/login' },
      },
      [{ id: 'builtin', available: true }],
    );
    const search = inputs.find((c) => c.name.includes('Search/query flood'));
    // /search is on the surface → kept and resolved against the origin.
    expect(search?.endpoints?.some((e) => e.url === 'https://bank.cz/search?q=alpha')).toBe(true);
    const pwreset = inputs.find((c) => c.name.includes('Password-reset'));
    // /password-reset etc. are auth-intent → seeded to the discovered login path.
    expect(pwreset?.endpoints?.every((e) => e.url === 'https://bank.cz/account/login')).toBe(true);
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

it('preserves the requested duration for rounded wave and ramp phases', () => {
  for (const profile of ['wave', 'ramp'] as const) {
    for (const duration of [1, 2, 3, 19, 20, 21, 120, 180]) {
      const phases = buildScenario(profile, 400, duration)!;
      expect(phases.reduce((sum, phase) => sum + phase.durationSec, 0)).toBe(duration);
      expect(
        phases.every((phase) => Number.isInteger(phase.durationSec) && phase.durationSec > 0),
      ).toBe(true);
    }
  }
});

it('preserves intentional missing-resource paths and monitors functional routes separately', () => {
  const pb = getPlaybook('pretest-cra-l7')!;
  const campaigns = buildSuiteCampaigns(
    pb,
    {
      ...target,
      recon: {
        paths: ['/', '/login.php', '/api/search.php'],
        dynamicPaths: ['/api/search.php'],
        loginPath: '/login.php',
      },
    },
    engines,
  );
  const random = campaigns.find((c) => c.name.includes('GET-Random-Flood'))!;
  expect(random.endpoints?.map((e) => new URL(e.url).pathname)).toEqual([
    '/nonexistent-a1',
    '/no/such/page',
    '/api/does-not-exist',
    '/random-9f2b',
  ]);
  expect(random.probeUrls).toBeUndefined();
  const post = campaigns.find((c) => c.name.includes('POST-Flood (DRS4)'))!;
  expect(post.probeUrls).toContain(target.probeUrl);
  expect(post.probeUrls).toContain('https://staging.example.com/api/search.php');
});
