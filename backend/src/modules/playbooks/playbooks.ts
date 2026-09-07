import { randomUUID } from 'node:crypto';
import type { CampaignInput, LoadVector, ScenarioPhase } from '../campaigns/model.js';
import {
  HARD_CAPS,
  MAX_ENDPOINTS,
  MAX_PLAYBOOK_STEPS as MAX_STEPS,
  MAX_PLAYBOOK_HEADERS as MAX_HEADERS,
} from '../../config/limits.js';

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
  /**
   * Optional custom request headers (built-in engine only) — benign strings for
   * a finer client fingerprint (e.g. Accept-Language, a mobile app header).
   * Never changes how requests are sent, only what headers they carry.
   */
  headers?: Record<string, string>;
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
  /**
   * Approximate DRS (DDoS Resiliency Score) attacker-capability level the
   * scenario's bounded shape maps to (documentation only — see
   * docs/assessment-methodology.md). Higher = more sophisticated TTP, not more
   * volume. Undefined for pure readiness/capacity/endurance templates.
   */
  drsLevel?: number;
  /** true for user-defined playbooks (curated ones are read-only). */
  custom?: boolean;
}

const PROFILES = ['constant', 'ramp', 'wave'];
const VECTORS = ['http-get', 'http-post'];

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
    let headers: Record<string, string> | undefined;
    if (s.headers !== undefined) {
      if (typeof s.headers !== 'object' || s.headers === null || Array.isArray(s.headers)) {
        throw new PlaybookError(`${label}: headers must be an object of string values.`);
      }
      const entries = Object.entries(s.headers as Record<string, unknown>);
      if (entries.length > MAX_HEADERS) {
        throw new PlaybookError(`${label}: at most ${MAX_HEADERS} headers.`);
      }
      const clean: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (typeof v !== 'string') {
          throw new PlaybookError(`${label}: header "${k}" must be a string.`);
        }
        if (k.trim()) clean[k.trim()] = v;
      }
      headers = Object.keys(clean).length ? clean : undefined;
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
      headers,
    };
  });
  let drsLevel: number | undefined;
  if (o.drsLevel !== undefined) {
    const n = Number(o.drsLevel);
    if (!Number.isInteger(n) || n < 1 || n > 7) {
      throw new PlaybookError('drsLevel must be an integer within [1, 7].');
    }
    drsLevel = n;
  }
  return {
    id: `custom-${randomUUID()}`,
    name,
    category: typeof o.category === 'string' && o.category.trim() ? o.category.trim() : 'Custom',
    summary: typeof o.summary === 'string' ? o.summary : '',
    when: typeof o.when === 'string' ? o.when : '',
    steps: cleanSteps,
    drsLevel,
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
    drsLevel: 4,
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
    drsLevel: 4,
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
    drsLevel: 3,
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
    drsLevel: 3,
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
    drsLevel: 3,
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
    id: 'threat-l7-multivector',
    name: 'L7 multi-vector',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'Baseline, then three bounded waves that vary the method, the endpoints and the ' +
      'fingerprint — the combined shape of a modern mixed L7 flood.',
    when: 'Measure combined WAF / rate-limit efficacy when method, URL and fingerprint all move.',
    threat: {
      technique: 'Multi-vector L7 (mixed method + endpoint + fingerprint)',
      reference: 'zeroBS L7 — http_multivector',
      measures: 'Combined edge defenses vs a shape that varies method, URL set and User-Agent.',
      notReproduced: 'Bounded rate; benign headers; no exhaustion, no spoofing.',
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
        name: 'GET mix wave',
        summary: 'Waves over a mix of endpoints, rotating User-Agent.',
        maxRps: 500,
        concurrency: 100,
        maxDurationSec: 120,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/', '/search?q=test', '/api/products', '/about', '/login'],
        rotateUa: true,
      },
      {
        name: 'POST wave',
        summary: 'Bounded POST load (method-policy pressure).',
        maxRps: 400,
        concurrency: 80,
        maxDurationSec: 120,
        profile: 'wave',
        vector: 'http-post',
        agent: 'builtin',
      },
    ],
  },
  {
    id: 'threat-iot-botnet',
    name: 'IoT-botnet L7 (sophisticated)',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'A baseline, then a bounded wave that spreads over deep application paths while ' +
      'rotating the client fingerprint — a sophisticated IoT-botnet L7 profile.',
    when: 'Assess bot-management / fingerprint classification under a mixed, bounded flood shape.',
    threat: {
      technique: 'Sophisticated IoT-botnet L7 (rotating fingerprints, deep paths)',
      reference: 'zeroBS L7 — get_flood (IoT v2)',
      measures: 'Fingerprint/bot classification when many benign UAs hit deep endpoints.',
      notReproduced:
        'Bounded rate; benign UAs from a fixed set; no botnet, no exhaustion, no spoofing.',
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
        name: 'IoT wave',
        summary: 'Waves over deep paths, rotating User-Agent.',
        maxRps: 500,
        concurrency: 120,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/', '/api/products', '/cart', '/search?q=a', '/account/orders'],
        rotateUa: true,
      },
    ],
  },
  {
    id: 'threat-ramp-plateau',
    name: 'Ramp & plateau',
    category: 'Threat-informed',
    drsLevel: 3,
    summary:
      'A slow ramp to a sustained plateau — reveals detection lag on a gradual rise and ' +
      'behaviour once load holds at the ceiling (the capacity knee).',
    when: 'Find how long detection lags on a slow ramp, and whether a plateau stays stable.',
    threat: {
      technique: 'Gradual ramp to plateau',
      reference: 'zeroBS DRS — RampUp / Plateau',
      measures: 'Detection lag on a slow ramp; stability of a sustained plateau.',
      notReproduced: 'Bounded ceiling; no volumetric — L7 requests only.',
    },
    steps: [
      {
        name: 'Ramp-up',
        summary: 'Gradually rising rate.',
        maxRps: 600,
        concurrency: 120,
        maxDurationSec: 240,
        profile: 'ramp',
        agent: 'builtin',
      },
      {
        name: 'Plateau',
        summary: 'Hold at the ceiling.',
        maxRps: 600,
        concurrency: 120,
        maxDurationSec: 180,
        profile: 'constant',
        agent: 'builtin',
      },
    ],
  },
  {
    id: 'threat-sync-pulse',
    name: 'Synchronized pulse',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'A baseline, then short high-concurrency bursts separated by lulls — the shape of a ' +
      'coordinated, synchronized strike, bounded.',
    when: 'Validate reaction to sudden synchronized bursts and recovery between pulses.',
    threat: {
      technique: 'Synchronized burst (coordinated strike)',
      reference: 'zeroBS glossary — THOR (synchronized strike)',
      measures: 'Reaction time to abrupt bursts and recovery in the lulls between pulses.',
      notReproduced: 'Bounded peak; a load shape only — not a real botnet time-sync.',
    },
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady reference load.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'builtin',
      },
      {
        name: 'Pulses',
        summary: 'Short high-concurrency bursts, then lulls.',
        maxRps: 700,
        concurrency: 200,
        maxDurationSec: 150,
        profile: 'wave',
        agent: 'builtin',
      },
    ],
  },
  {
    id: 'threat-chaos',
    name: 'Bounded chaos',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'A baseline, then two waves where the method, the URL set and the fingerprint all ' +
      'vary at once — a bounded take on a random-parameter (Chewy/Chaos) attacker.',
    when: 'Check defense stability when method, URL and fingerprint all change together.',
    threat: {
      technique: 'Randomized parameters (Chewy / Chaos)',
      reference: 'zeroBS glossary — Chewy / Chaos',
      measures: 'Whether classification/rate-limiting stays stable as parameters vary.',
      notReproduced:
        'Bounded rate; fixed benign parameter sets — no per-request randomization or cache-busting.',
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
        name: 'Chaos GET',
        summary: 'Waves over a URL mix, rotating User-Agent.',
        maxRps: 400,
        concurrency: 100,
        maxDurationSec: 120,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/', '/search?q=x', '/api/products', '/help', '/status'],
        rotateUa: true,
      },
      {
        name: 'Chaos POST',
        summary: 'Bounded POST waves, rotating User-Agent.',
        maxRps: 400,
        concurrency: 100,
        maxDurationSec: 120,
        profile: 'wave',
        vector: 'http-post',
        agent: 'builtin',
        rotateUa: true,
      },
    ],
  },
  {
    id: 'threat-header-fingerprint',
    name: 'Header fingerprint',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'A baseline, then a bounded wave that carries a fixed set of custom request headers ' +
      '(a specific client fingerprint) while rotating the User-Agent.',
    when: 'Test header/fingerprint-based classification (bot management, device rules).',
    threat: {
      technique: 'Client fingerprint spoofing via headers',
      reference: 'zeroBS L7 — get_flood (IoT v2)',
      measures: 'Header/fingerprint-based classification and rule matching at the edge.',
      notReproduced:
        'Bounded rate; benign, fixed header values — no TLS/JA4 manipulation, no exhaustion.',
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
        name: 'Fingerprint wave',
        summary: 'Waves carrying a fixed client fingerprint (custom headers), rotating UA.',
        maxRps: 500,
        concurrency: 100,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'builtin',
        rotateUa: true,
        headers: {
          'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8',
          'X-Requested-With': 'com.example.mobileapp',
          'Sec-CH-UA-Mobile': '?1',
        },
      },
    ],
  },
  {
    id: 'threat-http2-continuation',
    name: 'HTTP/2 Continuation — header pressure',
    category: 'Threat-informed',
    drsLevel: 5,
    summary:
      'A baseline, then a steady wave of header-heavy requests carrying a fixed, benign browser ' +
      'header block — the bounded shape of an HTTP/2 CONTINUATION-flood, testing header parsing/limits.',
    when: 'Validate header-size/count limits and header-parsing resilience at the edge (h2 CONTINUATION-flood shape).',
    threat: {
      technique: 'HTTP/2 Continuation Flood — header-block pressure',
      reference: 'HTTP/2 CONTINUATION Flood (CVE-2024-27316 / CVE-2024-27919, 2024)',
      measures:
        'Whether the edge enforces header count/size limits and parses a large-but-bounded header block without degradation.',
      notReproduced:
        'No never-terminated HEADERS/CONTINUATION frame stream, no h2 frame-level abuse — only complete, ' +
        'rate-capped requests with a fixed benign header set (≤10 headers).',
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
        name: 'Header-pressure wave',
        summary: 'Steady load carrying a fixed benign browser header block.',
        maxRps: 600,
        concurrency: 120,
        maxDurationSec: 180,
        profile: 'constant',
        agent: 'builtin',
        rotateUa: true,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,cs;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          Referer: 'https://www.google.com/',
          'Sec-CH-UA': '"Chromium";v="124", "Not.A/Brand";v="24"',
          'Sec-CH-UA-Platform': '"Windows"',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
        },
      },
    ],
  },
  {
    id: 'threat-madeyoureset',
    name: 'MadeYouReset — h2 request burst',
    category: 'Threat-informed',
    drsLevel: 5,
    summary:
      'A baseline, then a high, steady request rate over HTTP/2 (k6/vegeta negotiate h2 on HTTPS) — ' +
      'the bounded request-path shape of a MadeYouReset-class strike, without the reset abuse.',
    when: 'Validate the HTTP/2 request path and connection accounting under a sustained bounded rate.',
    threat: {
      technique: 'HTTP/2 request burst (MadeYouReset class)',
      reference: 'MadeYouReset — CVE-2025-8671 (2025)',
      measures:
        'How the h2 request path and per-connection accounting hold up under a sustained, bounded, complete-request rate.',
      notReproduced:
        'No server-triggered RST_STREAM amplification, no malformed control frames, no stream-reset abuse — ' +
        'only complete, rate-capped requests.',
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
    id: 'threat-aisuru-botnet',
    name: 'Aisuru-class botnet fan-out',
    category: 'Threat-informed',
    drsLevel: 5,
    summary:
      'A baseline, then two high-concurrency waves spreading over deep application paths while ' +
      'rotating both the User-Agent and a benign header fingerprint — the bounded shape of a modern, ' +
      'record-setting L7 botnet (Aisuru/Mirai-class), without the botnet or its volume.',
    when: 'Assess bot-management, fingerprint classification and rate-limiting against a large, diverse, bounded L7 fan-out.',
    threat: {
      technique: 'Hyper-volumetric L7 botnet fan-out (Aisuru / Mirai-class)',
      reference: 'Aisuru / record hyper-volumetric L7 botnets (2024–2025)',
      measures:
        'Whether classification and rate-limiting stay stable when a diverse, high-concurrency but rate-bounded L7 load hits deep endpoints.',
      notReproduced:
        'No botnet, no real node count, no hyper-volume — bounded RPS/concurrency, benign UAs and headers from fixed sets, no spoofing.',
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
        name: 'Fan-out wave',
        summary: 'High-concurrency waves over deep paths, rotating UA + header fingerprint.',
        maxRps: 700,
        concurrency: 300,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/', '/api/products', '/cart', '/search?q=a', '/account/orders', '/checkout'],
        rotateUa: true,
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-CH-UA-Mobile': '?1',
          'X-Requested-With': 'XMLHttpRequest',
        },
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
    const headers = builtin && step.headers ? step.headers : undefined;
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
      headers,
      recurrence: t.recurrenceMin ? { intervalMin: t.recurrenceMin } : undefined,
      suiteId,
      suiteName: playbook.name,
      suiteOrder: i,
    };
  });
}
