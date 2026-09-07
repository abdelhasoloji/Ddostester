import { randomUUID } from 'node:crypto';
import { HARD_CAPS } from '../campaigns/model.js';
import type { CampaignInput, LoadVector, ScenarioPhase } from '../campaigns/model.js';
import { MAX_ENDPOINTS } from '../../engine/types.js';

export class PlaybookError extends Error {}

/**
 * Assessment playbooks: curated, ordered sequences of BOUNDED campaigns that
 * together form a resilience assessment (the "one-click assessment" idea, done
 * safely). A playbook sets load shapes only — never a target — and every
 * campaign it produces still goes through approval and the caps. No attack
 * vector: each step is the same bounded HTTP generator as everywhere else.
 */

export type LoadProfile = 'constant' | 'ramp' | 'wave';

/**
 * A realistic default set of current browser/mobile User-Agent strings, used by
 * threat-informed templates that rotate the client fingerprint. Benign strings
 * only — this changes a header, never how requests are sent.
 */
export const DEFAULT_UA_SET: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
];

export interface PlaybookStep {
  name: string;
  summary: string;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  profile: LoadProfile;
  /**
   * HTTP method vector for this step. Default 'http-get'. 'http-post' exercises
   * a bounded POST load (e.g. an HTTP-method-policy probe). Still the same
   * bounded generator — never a flood or exhaustion vector.
   */
  vector?: LoadVector;
  /** Preferred engine (applied when installed, else the server default). */
  agent?: string;
  /**
   * Optional realism (built-in engine only): relative paths spread as a weighted
   * endpoint mix, resolved against the target at instantiation.
   */
  paths?: string[];
  /** Optional realism (built-in engine only): rotate the DEFAULT_UA_SET. */
  rotateUa?: boolean;
}

/**
 * Threat context for a threat-informed template: what recent pattern its
 * bounded traffic profile approximates, what it measures, and — crucially —
 * what harmful mechanism it deliberately does NOT reproduce. Documentation
 * only; it never changes what is sent.
 */
export interface ThreatInfo {
  technique: string;
  /** Public reference (CVE / advisory / name). */
  reference: string;
  /** What resilience question the run answers. */
  measures: string;
  /** The harmful mechanism intentionally left out (kept a measurement, not an attack). */
  notReproduced: string;
}

export interface Playbook {
  id: string;
  name: string;
  category: string;
  summary: string;
  /** When to run this assessment. */
  when: string;
  steps: PlaybookStep[];
  /** Threat context for threat-informed templates (curated only). */
  threat?: ThreatInfo;
  /** true for user-defined playbooks (curated ones are read-only). */
  custom?: boolean;
}

const PROFILES = ['constant', 'ramp', 'wave'];
const VECTORS = ['http-get', 'http-post'];
const MAX_STEPS = 12;

/**
 * Validates a user-submitted playbook and returns a clean, stored Playbook.
 * Every step must stay within HARD_CAPS — a custom playbook can never widen the
 * bounds. Throws PlaybookError on any problem.
 */
export function validatePlaybookInput(input: unknown): Playbook {
  const o = (input ?? {}) as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) throw new PlaybookError('Playbook name is required.');
  const steps = Array.isArray(o.steps) ? o.steps : [];
  if (steps.length < 1 || steps.length > MAX_STEPS) {
    throw new PlaybookError(`A playbook must have between 1 and ${MAX_STEPS} steps.`);
  }
  const cleanSteps: PlaybookStep[] = steps.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const maxRps = Number(s.maxRps);
    const concurrency = Number(s.concurrency);
    const maxDurationSec = Number(s.maxDurationSec);
    const profile = String(s.profile ?? 'constant');
    const label = `Step ${i + 1}`;
    if (!(maxRps > 0) || maxRps > HARD_CAPS.maxRps) {
      throw new PlaybookError(`${label}: maxRps must be within ]0, ${HARD_CAPS.maxRps}].`);
    }
    if (!(concurrency >= 1) || concurrency > HARD_CAPS.maxConcurrency) {
      throw new PlaybookError(
        `${label}: concurrency must be within [1, ${HARD_CAPS.maxConcurrency}].`,
      );
    }
    if (!(maxDurationSec >= 1) || maxDurationSec > HARD_CAPS.maxDurationSec) {
      throw new PlaybookError(
        `${label}: maxDurationSec must be within [1, ${HARD_CAPS.maxDurationSec}].`,
      );
    }
    if (!PROFILES.includes(profile)) {
      throw new PlaybookError(`${label}: profile must be one of ${PROFILES.join(', ')}.`);
    }
    const vector = s.vector === undefined ? 'http-get' : String(s.vector);
    if (!VECTORS.includes(vector)) {
      throw new PlaybookError(`${label}: vector must be one of ${VECTORS.join(', ')}.`);
    }
    let paths: string[] | undefined;
    if (s.paths !== undefined) {
      if (!Array.isArray(s.paths) || s.paths.length > MAX_ENDPOINTS) {
        throw new PlaybookError(`${label}: paths must be an array of at most ${MAX_ENDPOINTS}.`);
      }
      paths = s.paths.map((p) => String(p)).filter((p) => p.trim());
      if (paths.length === 0) paths = undefined;
    }
    return {
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : label,
      summary: typeof s.summary === 'string' ? s.summary : '',
      maxRps,
      concurrency,
      maxDurationSec,
      profile: profile as LoadProfile,
      vector: vector as LoadVector,
      agent: typeof s.agent === 'string' && s.agent ? s.agent : undefined,
      paths,
      rotateUa: s.rotateUa === true,
    };
  });
  return {
    id: `custom-${randomUUID()}`,
    name,
    category: typeof o.category === 'string' && o.category.trim() ? o.category.trim() : 'Custom',
    summary: typeof o.summary === 'string' ? o.summary : '',
    when: typeof o.when === 'string' ? o.when : '',
    steps: cleanSteps,
    custom: true,
  };
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'quick-readiness',
    name: 'Quick readiness check',
    category: 'Readiness',
    summary:
      'A fast smoke test then a short baseline — confirm the target is testable and healthy.',
    when: 'Before a real assessment, or as a routine daily/nightly check.',
    steps: [
      {
        name: 'Smoke',
        summary: 'Tiny end-to-end check.',
        maxRps: 10,
        concurrency: 3,
        maxDurationSec: 20,
        profile: 'constant',
        agent: 'builtin',
      },
      {
        name: 'Baseline',
        summary: 'Steady reference load.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'vegeta',
      },
    ],
  },
  {
    id: 'capacity-assessment',
    name: 'Capacity assessment',
    category: 'Capacity',
    summary: 'Baseline, then a ramp to find the knee, then a high steady ceiling.',
    when: 'Quantify how much sustained load the service absorbs before degrading.',
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady reference load.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'vegeta',
      },
      {
        name: 'Ramp-up (find the knee)',
        summary: 'Gradually rising rate.',
        maxRps: 300,
        concurrency: 50,
        maxDurationSec: 180,
        profile: 'ramp',
        agent: 'k6',
      },
      {
        name: 'Capacity ceiling',
        summary: 'High steady rate.',
        maxRps: 800,
        concurrency: 150,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'vegeta',
      },
    ],
  },
  {
    id: 'burst-resilience',
    name: 'Burst resilience',
    category: 'Stress',
    summary: 'Baseline then alternating spikes — how protection and autoscaling react and recover.',
    when: 'Validate defenses against sudden bursts (the closest safe analogue to a spike event).',
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady reference load.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'vegeta',
      },
      {
        name: 'Spike / waves',
        summary: 'Alternating bursts and lulls.',
        maxRps: 500,
        concurrency: 100,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'k6',
      },
    ],
  },
  {
    id: 'threat-l7-signature-evasion',
    name: 'L7 wave — signature evasion',
    category: 'Threat-informed',
    summary:
      'A baseline, then a wave that spreads over several endpoints while rotating the ' +
      'client User-Agent — the bounded traffic profile of a modern L7 flood.',
    when: 'Measure how well the WAF / rate-limiter copes with rotating fingerprints and mixed URLs.',
    threat: {
      technique: 'Web DDoS "Tsunami" — randomized L7 flood',
      reference: 'Industry L7 DDoS trend 2023–2024',
      measures: 'WAF / rate-limit efficacy against fingerprint rotation and endpoint spread.',
      notReproduced:
        'No exhaustion, no spoofing — only bounded HTTP with rotating benign headers and mixed paths.',
    },
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady single-URL reference.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'builtin',
      },
      {
        name: 'Evasion wave',
        summary: 'Waves over a mix of endpoints, rotating User-Agent.',
        maxRps: 500,
        concurrency: 100,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/', '/search?q=test', '/api/products', '/about', '/login'],
        rotateUa: true,
      },
    ],
  },
  {
    id: 'threat-http2-burst',
    name: 'HTTP/2 multiplexed burst',
    category: 'Threat-informed',
    summary:
      'A high, steady request rate over HTTP/2 (k6/vegeta negotiate h2 on HTTPS) — the bounded ' +
      'load profile of an h2 request burst, to test the h2 request path.',
    when: 'Validate HTTP/2 request-handling resilience under a bounded high rate.',
    threat: {
      technique: 'HTTP/2 request burst',
      reference: 'HTTP/2 Rapid Reset — CVE-2023-44487',
      measures: 'How the HTTP/2 request path holds up under a sustained bounded rate.',
      notReproduced:
        'No RST_STREAM flood / stream-cancel abuse — only complete, rate-capped requests.',
    },
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady reference load.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'vegeta',
      },
      {
        name: 'HTTP/2 burst',
        summary: 'High steady rate over h2 (HTTPS target).',
        maxRps: 800,
        concurrency: 150,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'k6',
      },
    ],
  },
  {
    id: 'threat-cache-key-stress',
    name: 'Cache-key stress (bounded)',
    category: 'Threat-informed',
    summary:
      'Spreads a steady load over a fixed set of URLs to exercise cache behaviour — without ' +
      'per-request cache-busters (which would be a bypass technique).',
    when: 'Assess cache-hit ratio and origin protection under a realistic mixed-URL load.',
    threat: {
      technique: 'Cache-key stress',
      reference: 'Cache-targeting L7 patterns',
      measures: 'Cache-hit behaviour and origin shielding across a set of URLs.',
      notReproduced:
        'No unique-per-request query strings (cache-buster bypass, TSD V-L7-05) — a fixed URL set only.',
    },
    steps: [
      {
        name: 'Mixed-URL load',
        summary: 'Steady load spread over a fixed URL set.',
        maxRps: 300,
        concurrency: 50,
        maxDurationSec: 180,
        profile: 'constant',
        agent: 'builtin',
        paths: ['/', '/pricing', '/api/catalog', '/assets/app.js', '/docs'],
      },
    ],
  },
  {
    id: 'threat-url-allowlist',
    name: 'L7 — URL-allowlist probe',
    category: 'Threat-informed',
    summary:
      'A baseline, then a bounded wave spread over a fixed set of non-existent paths — ' +
      'checks that the edge returns 404 / enforces its URL allowlist instead of hitting the origin.',
    when: 'Verify edge URL filtering (origin shielding) against a random-URL L7 flood shape.',
    threat: {
      technique: 'Random-URL L7 flood',
      reference: 'zeroBS L7 — random_flood',
      measures: 'Edge URL-allowlist / 404 enforcement and origin shielding.',
      notReproduced:
        'Bounded rate; a fixed set of non-existent paths (no unique-per-request cache-busters).',
    },
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady valid-URL reference.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'builtin',
      },
      {
        name: 'Random-URL wave',
        summary: 'Waves over non-existent paths (expect 404 at the edge).',
        maxRps: 500,
        concurrency: 100,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'builtin',
        paths: [
          '/nonexistent-a1',
          '/no/such/page',
          '/api/does-not-exist',
          '/.well-known/none',
          '/random-9f2b',
        ],
      },
    ],
  },
  {
    id: 'threat-method-policy',
    name: 'L7 — method policy (POST)',
    category: 'Threat-informed',
    summary:
      'A GET baseline, then a bounded POST wave — checks that the edge enforces its ' +
      'HTTP-method allowlist (e.g. 405) rather than passing POSTs through to the origin.',
    when: 'Verify HTTP-method-allowlist enforcement against a POST-flood shape.',
    threat: {
      technique: 'POST/PUT method flood',
      reference: 'zeroBS L7 — post_flood',
      measures: 'HTTP method allowlist / 405 enforcement at the edge.',
      notReproduced:
        'Bounded rate; GET/POST only (no PUT); no exhaustion — complete, rate-capped requests.',
    },
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady GET reference.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'builtin',
      },
      {
        name: 'POST wave',
        summary: 'Bounded POST load (expect method-policy 405).',
        maxRps: 400,
        concurrency: 80,
        maxDurationSec: 180,
        profile: 'wave',
        vector: 'http-post',
        agent: 'builtin',
      },
    ],
  },
  {
    id: 'endurance',
    name: 'Endurance / soak',
    category: 'Endurance',
    summary: 'A long, gentle load to reveal slow degradation, leaks or resource exhaustion.',
    when: 'Before a release, to catch problems that only appear over time.',
    steps: [
      {
        name: 'Soak',
        summary: 'Long, gentle load.',
        maxRps: 50,
        concurrency: 20,
        maxDurationSec: 900,
        profile: 'constant',
        agent: 'builtin',
      },
    ],
  },
];

export function getPlaybook(id: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.id === id);
}

/** Builds the bounded phases for a profile (mirrors the UI's buildScenario). */
export function buildScenario(
  profile: LoadProfile,
  maxRps: number,
  durationSec: number,
): ScenarioPhase[] | undefined {
  const third = Math.max(1, Math.round(durationSec / 3));
  const pct = (p: number): number => Math.max(1, Math.round((maxRps * p) / 100));
  if (profile === 'ramp')
    return [
      { maxRps: pct(25), durationSec: third },
      { maxRps: pct(50), durationSec: third },
      { maxRps: pct(100), durationSec: third },
    ];
  if (profile === 'wave')
    return [
      { maxRps: pct(100), durationSec: third },
      { maxRps: pct(20), durationSec: third },
      { maxRps: pct(100), durationSec: third },
    ];
  return undefined;
}

export interface SuiteTarget {
  target: string;
  probeUrl: string;
  createdBy: string;
  /** Optional: make every campaign of the suite recurring (minutes between runs). */
  recurrenceMin?: number;
}

/** Metadata for an installed engine (to only pick engines that are available). */
export interface EngineAvailability {
  id: string;
  available: boolean;
}

/**
 * Turns a playbook into a list of CampaignInput linked by a shared suiteId.
 * Each step's preferred engine is used only if installed; otherwise the server
 * default. The campaigns are NOT approved here — governance is unchanged.
 */
export function buildSuiteCampaigns(
  playbook: Playbook,
  t: SuiteTarget,
  engines: EngineAvailability[] = [],
): CampaignInput[] {
  const suiteId = randomUUID();
  const isAvailable = (id?: string): boolean =>
    id != null && engines.some((e) => e.id === id && e.available);
  let origin = t.target;
  try {
    origin = new URL(t.target).origin;
  } catch {
    /* keep raw; createCampaign will reject an invalid target */
  }
  return playbook.steps.map((step, i) => {
    const agent = isAvailable(step.agent) ? step.agent : undefined;
    // Endpoint mix and UA rotation are built-in-engine features: only attach
    // them when the resolved engine is the built-in one (explicit or default).
    const builtin = agent === 'builtin' || agent === undefined;
    const endpoints =
      builtin && step.paths?.length ? step.paths.map((p) => ({ url: `${origin}${p}` })) : undefined;
    const userAgents = builtin && step.rotateUa ? DEFAULT_UA_SET : undefined;
    return {
      name: `${playbook.name} — ${step.name}`,
      description: step.summary,
      target: t.target,
      vector: step.vector ?? 'http-get',
      maxRps: step.maxRps,
      concurrency: step.concurrency,
      maxDurationSec: step.maxDurationSec,
      probeUrl: t.probeUrl,
      createdBy: t.createdBy,
      authorized: true,
      scenario: buildScenario(step.profile, step.maxRps, step.maxDurationSec),
      agent,
      endpoints,
      userAgents,
      recurrence: t.recurrenceMin ? { intervalMin: t.recurrenceMin } : undefined,
      suiteId,
      suiteName: playbook.name,
      suiteOrder: i,
    };
  });
}
