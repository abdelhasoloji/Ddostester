import { describe, it, expect } from 'vitest';
import { PLAYBOOKS, buildSuiteCampaigns } from '../src/modules/playbooks/playbooks.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { HARD_CAPS } from '../src/config/limits.js';

// Instantiation gate for every curated template, exactly as the
// POST /api/playbooks/:id/instantiate endpoint runs it: build the suite of
// campaigns for a target, then push each through createCampaign() (the same
// validation + caps enforcement production uses). No load is generated — this
// only proves every template turns into a valid, in-caps campaign for bank.cz.
const TARGET = 'https://bank.cz';
const ALLOWED = ['bank.cz'];
// Mark the preferred engines available so steps keep their intended engine and
// their endpoint-mix / UA-rotation realism is exercised, not silently dropped.
const ENGINES = [
  { id: 'builtin', available: true },
  { id: 'vegeta', available: true },
  { id: 'k6', available: true },
];
// Real engine capabilities (mirror backend/src/agents/*.ts) so the multi-phase /
// flow validation in createCampaign is exercised faithfully. builtin, vegeta and
// k6 all support multi-phase scenarios (ramp/wave) — the profiles the templates use.
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

describe('curated templates instantiate into valid campaigns for bank.cz', () => {
  it('exposes a stable set of curated templates', () => {
    expect(PLAYBOOKS.length).toBeGreaterThanOrEqual(19);
    // ids are unique
    expect(new Set(PLAYBOOKS.map((p) => p.id)).size).toBe(PLAYBOOKS.length);
  });

  it('focusDynamic concentrates the flood on recon dynamic paths, not the static surface', () => {
    const pb = {
      id: 'x',
      name: 'X',
      category: 'Stress',
      summary: '',
      when: '',
      steps: [
        {
          name: 'exhaust',
          summary: '',
          maxRps: 400,
          concurrency: 500,
          maxDurationSec: 60,
          profile: 'constant' as const,
          vector: 'http-get' as const,
          focusDynamic: true,
        },
      ],
    };
    const recon = {
      paths: ['/', '/style.css', '/about.html', '/api/work.php?ms=50', '/api/echo.php'],
      // recon orders dynamicPaths most-expensive-first; the costliest is work.php.
      dynamicPaths: ['/api/work.php?ms=50', '/api/echo.php'],
    };
    const [input] = buildSuiteCampaigns(
      pb,
      { target: TARGET, probeUrl: TARGET, createdBy: 'test', recon },
      ENGINES,
    );
    const urls = (input.endpoints ?? []).map((e) => e.url);
    // ALL fire concentrates on the single costliest dynamic path — the cheap
    // echo.php is NOT included (it would dilute the pressure), and no static.
    expect(urls).toEqual(['https://bank.cz/api/work.php?ms=50']);
    // A flood concentrated on the app tier is delivered with fresh connections
    // (connection pressure is what actually collapses an origin).
    expect(input.noKeepAlive).toBe(true);

    // RELEVANCE FALLBACK: even WITHOUT focusDynamic, a pathless (root-only) flood
    // is redirected to the costliest dynamic path — otherwise it would harmlessly
    // hit a bare origin's free static surface.
    const [plain] = buildSuiteCampaigns(
      { ...pb, steps: [{ ...pb.steps[0], focusDynamic: undefined }] },
      { target: TARGET, probeUrl: TARGET, createdBy: 'test', recon },
      ENGINES,
    );
    expect((plain.endpoints ?? []).map((e) => e.url)).toEqual([
      'https://bank.cz/api/work.php?ms=50',
    ]);

    // But a step with a REAL (non-root) path that maps to the surface keeps its
    // own mix — a target-tuned line is not overridden where it applies.
    const [mix] = buildSuiteCampaigns(
      { ...pb, steps: [{ ...pb.steps[0], focusDynamic: false, paths: ['/api/echo.php'] }] },
      { target: TARGET, probeUrl: TARGET, createdBy: 'test', recon },
      ENGINES,
    );
    expect((mix.endpoints ?? []).map((e) => e.url)).toEqual(['https://bank.cz/api/echo.php']);
  });

  it('a low-rate baseline / fingerprint sweep is left keep-alive (not a flood)', () => {
    const recon = { paths: ['/', '/api/x.php'], dynamicPaths: ['/api/x.php'] };
    const [base] = buildSuiteCampaigns(
      {
        id: 'b',
        name: 'B',
        category: 'Readiness',
        summary: '',
        when: '',
        steps: [
          {
            name: 'Baseline',
            summary: '',
            maxRps: 100,
            concurrency: 20,
            maxDurationSec: 60,
            profile: 'constant' as const,
            vector: 'http-get' as const,
          },
        ],
      },
      { target: TARGET, probeUrl: TARGET, createdBy: 'test', recon },
      ENGINES,
    );
    expect(base.noKeepAlive).toBeUndefined();
  });

  it('an HTTP/2 flood line is left keep-alive (needs a persistent multiplexed connection)', () => {
    const recon = { paths: ['/', '/api/x.php'], dynamicPaths: ['/api/x.php'] };
    const [h2] = buildSuiteCampaigns(
      {
        id: 'h',
        name: 'H',
        category: 'Threat-informed',
        summary: '',
        when: '',
        steps: [
          {
            name: 'HTTP/2 burst',
            summary: '',
            maxRps: 800,
            concurrency: 150,
            maxDurationSec: 60,
            profile: 'constant' as const,
            vector: 'http-get' as const,
          },
        ],
      },
      { target: TARGET, probeUrl: TARGET, createdBy: 'test', recon },
      ENGINES,
    );
    expect(h2.noKeepAlive).toBeUndefined();
  });

  it('the curated origin-exhaustion template opts into dynamic focus on every step', () => {
    const pb = PLAYBOOKS.find((p) => p.id === 'origin-l7-exhaustion');
    expect(pb).toBeTruthy();
    expect(pb!.steps.every((s) => (s as { focusDynamic?: boolean }).focusDynamic === true)).toBe(
      true,
    );
  });

  for (const pb of PLAYBOOKS) {
    it(`instantiates "${pb.id}" (${pb.steps.length} step(s)) within caps`, () => {
      const inputs = buildSuiteCampaigns(
        pb,
        { target: TARGET, probeUrl: TARGET, createdBy: 'test' },
        ENGINES,
      );
      expect(inputs.length).toBe(pb.steps.length);

      inputs.forEach((input, i) => {
        // Must not throw — this is the exact production creation gate.
        const c = createCampaign(input, ALLOWED, AGENTS, HARD_CAPS);
        const where = `${pb.id} step ${i + 1} (${pb.steps[i].name})`;
        // Every enforced bound holds.
        expect(c.maxRps, `${where}: maxRps`).toBeLessThanOrEqual(HARD_CAPS.maxRps);
        expect(c.concurrency, `${where}: concurrency`).toBeLessThanOrEqual(
          HARD_CAPS.maxConcurrency,
        );
        expect(c.maxDurationSec, `${where}: duration`).toBeLessThanOrEqual(
          HARD_CAPS.maxDurationSec,
        );
        // Target stayed the allowlisted host, and the suite linkage is intact.
        expect(new URL(c.target).host, `${where}: host`).toBe('bank.cz');
        expect(c.suiteOrder, `${where}: order`).toBe(i);
        // Any resolved endpoints stay on the allowlisted host.
        for (const ep of c.endpoints ?? []) {
          expect(new URL(ep.url).host, `${where}: endpoint host`).toBe('bank.cz');
        }
      });
    });
  }
});
