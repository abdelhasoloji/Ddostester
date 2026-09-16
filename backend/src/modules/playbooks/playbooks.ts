import { randomUUID } from 'node:crypto';
import type { CampaignInput, LoadVector, ScenarioPhase } from '../campaigns/model.js';
import {
  HARD_CAPS,
  MAX_ENDPOINTS,
  MAX_PLAYBOOK_STEPS as MAX_STEPS,
  MAX_PLAYBOOK_HEADERS as MAX_HEADERS,
} from '../../config/limits.js';
import type { HardCaps } from '../../config/limits.js';

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
  /**
   * Cache-busting (vegeta/k6): append a unique `?_cb=` to every request so a
   * cache/CDN can't absorb the flood — each request reaches origin. Measures the
   * origin, not the edge cache.
   */
  cacheBust?: boolean;
  /**
   * No keep-alive: a fresh TCP (and TLS) connection per request, so the step also
   * exercises the connection-accept / handshake path, not just request handling.
   */
  noKeepAlive?: boolean;
  /**
   * Parallel generation (vegeta): split the phase rate across N concurrent
   * workers (each at rate/N), for a single box to sustain a higher offered rate.
   * Clamped to [1, MAX_VEGETA_PARALLELISM] downstream.
   */
  parallelism?: number;
  /**
   * Closed-loop rate calibration (GEN-1): fire a short pre-flight burst to
   * measure the deliverable rate, then grade at it instead of an aspirational
   * rate the box can't sustain. Recommended on high-rate composite/pulse lines
   * whose configured rate may exceed a single box's throughput, so their verdict
   * is a valid measurement rather than an under-delivered INCONCLUSIVE.
   */
  calibrate?: boolean;
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
  /**
   * Class-C network-bench companion: the synthetic, no-spoof lab ladder that
   * pairs with this L7 template for a CROSS-LAYER assessment (L7 here + L3/4 on
   * the isolated bench). The control plane never executes it — a CISO records
   * the bench-run requests and the isolated lab returns read-only verdicts that
   * fuse into the WRS (see crossLayerAssurance). `ladder` is a CLASS_C_LADDERS id.
   */
  companionBench?: { ladder: string; note: string };
  /** true for user-defined playbooks (curated ones are read-only). */
  custom?: boolean;
  /**
   * When this template was created (ISO 8601). Curated templates carry the date
   * the template was introduced; custom templates are stamped at creation. Used
   * by the UI to show the date and to offer a "recent first" ordering.
   */
  createdAt?: string;
}

const PROFILES = ['constant', 'ramp', 'wave'];
const VECTORS = ['http-get', 'http-post'];
/**
 * Upper bound on a step's parallel-generation fan-out. Mirrors the vegeta
 * adapter's `MAX_VEGETA_PARALLELISM` (the engine clamps to it anyway); kept as a
 * local constant so the playbook module doesn't import the agent.
 */
const MAX_PLAYBOOK_PARALLELISM = 8;

/**
 * Validates a user-submitted playbook and returns a clean, stored Playbook.
 * Every step must stay within HARD_CAPS — a custom playbook can never widen the
 * bounds. Throws PlaybookError on any problem.
 */
export function validatePlaybookInput(input: unknown, caps: HardCaps = HARD_CAPS): Playbook {
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
    if (!(maxRps > 0) || maxRps > caps.maxRps) {
      throw new PlaybookError(`${label}: maxRps must be within ]0, ${caps.maxRps}].`);
    }
    if (!(concurrency >= 1) || concurrency > caps.maxConcurrency) {
      throw new PlaybookError(`${label}: concurrency must be within [1, ${caps.maxConcurrency}].`);
    }
    if (!(maxDurationSec >= 1) || maxDurationSec > caps.maxDurationSec) {
      throw new PlaybookError(
        `${label}: maxDurationSec must be within [1, ${caps.maxDurationSec}].`,
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
    let parallelism: number | undefined;
    if (s.parallelism !== undefined) {
      const n = Number(s.parallelism);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PLAYBOOK_PARALLELISM) {
        throw new PlaybookError(
          `${label}: parallelism must be an integer within [1, ${MAX_PLAYBOOK_PARALLELISM}].`,
        );
      }
      if (n > 1) parallelism = n;
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
      calibrate: s.calibrate === true,
      headers,
      cacheBust: s.cacheBust === true || undefined,
      noKeepAlive: s.noKeepAlive === true || undefined,
      parallelism,
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
    createdAt: new Date().toISOString(),
  };
}

const CURATED_PLAYBOOKS: Playbook[] = [
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
      reference: 'Industry L7 DDoS trend 2023–2026; Cloudflare DDoS threat report H1 2026',
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
      reference: 'Cache-targeting L7 patterns; Cloudflare DDoS threat report H1 2026',
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
      reference:
        'Aisuru/Kimwolf record L7 botnets (2025–2026); Cloudflare H1 2026 record L7 attack — 2.45 billion HTTP requests across 1.2 million IPs',
      measures:
        'Whether classification and rate-limiting stay stable when a diverse, high-concurrency but rate-bounded L7 load hits deep endpoints — the bounded analogue of an extreme source/fingerprint diversity profile.',
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
    id: 'threat-micro-burst-train',
    name: 'Micro-burst train (sub-minute pulses)',
    category: 'Threat-informed',
    drsLevel: 5,
    summary:
      'A baseline, then a train of very short, back-to-back high-concurrency bursts rather ' +
      'than one sustained wave — the bounded shape of the record-setting sub-minute ' +
      'hyper-bursts (Aisuru/Kimwolf "Night Before Christmas", Dec 2025).',
    when: 'Measure how fast the edge / autoscaling reacts to sub-minute bursts and recovers between them — detection latency, not sustained volume.',
    threat: {
      technique: 'Sub-minute hyper-burst train (record short-duration DDoS)',
      reference:
        'Aisuru/Kimwolf 31.4 Tbps / 35s burst & "The Night Before Christmas" campaign (Dec 2025); Cloudflare DDoS threat report H1 2026 (short attacks)',
      measures:
        'Reaction latency and recovery of rate-limiting / autoscaling against repeated short bursts too brief for slow mitigation to ramp.',
      notReproduced:
        'No hyper-volume, no botnet, no L3/4 — bounded RPS/concurrency, several short HTTP waves only. Volumetric short-burst shape belongs to shieldtest-lab.',
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
        name: 'Burst 1 (≈45s)',
        summary: 'Short high-concurrency burst, then immediate lull.',
        maxRps: 700,
        concurrency: 300,
        maxDurationSec: 45,
        profile: 'wave',
        agent: 'builtin',
      },
      {
        name: 'Burst 2 (≈45s)',
        summary: 'Repeat burst — tests reaction before mitigation settles.',
        maxRps: 700,
        concurrency: 300,
        maxDurationSec: 45,
        profile: 'wave',
        agent: 'builtin',
      },
      {
        name: 'Burst 3 (≈45s)',
        summary: 'Third burst — recovery and stability between pulses.',
        maxRps: 700,
        concurrency: 300,
        maxDurationSec: 45,
        profile: 'wave',
        agent: 'builtin',
      },
    ],
  },
  {
    id: 'threat-ransom-demo',
    name: 'Ransom-DDoS demonstration burst',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'A baseline, then a single short, bounded spike — the shape of the brief "demonstration" ' +
      'burst an extortion actor fires alongside a ransom note to prove capability.',
    when: 'Check whether a single brief L7 spike trips mitigation, and how quickly the service recovers afterwards.',
    threat: {
      technique: 'Ransom DDoS (RDDoS) demonstration spike',
      reference: 'Cloudflare DDoS threat report H1 2026 (ransom DDoS trend)',
      measures:
        'Whether a one-off short spike is absorbed or triggers mitigation, and the recovery time once it stops.',
      notReproduced:
        'No extortion, no sustained campaign, no volumetric — one bounded HTTP wave only.',
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
        name: 'Demo spike',
        summary: 'Single short bounded spike (demonstration shape).',
        maxRps: 600,
        concurrency: 150,
        maxDurationSec: 90,
        profile: 'wave',
        agent: 'builtin',
      },
    ],
  },
  {
    id: 'threat-api-post-storm',
    name: 'API / JSON POST storm',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'A GET baseline, then a bounded POST wave aimed at expensive application/API endpoints ' +
      '(search, GraphQL, login, cart) carrying a realistic JSON API fingerprint — the modern ' +
      'business-logic L7 shape, not a static-URL flood.',
    when: 'Measure rate-limiting / WAF and origin protection on costly API endpoints, where each request does real work.',
    threat: {
      technique: 'API-targeted L7 (expensive business-logic endpoints)',
      reference: 'Cloudflare DDoS threat report H1 2026 (sophisticated L7; API-targeted attacks)',
      measures:
        'Whether per-endpoint rate-limits / WAF rules protect costly API paths, and how the origin copes when each POST triggers real work.',
      notReproduced:
        'Bounded rate; benign JSON fingerprint from a fixed set; no credential stuffing, no injection payloads, no exhaustion.',
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
        name: 'API POST wave',
        summary: 'Bounded POST load over API endpoints, JSON fingerprint, rotating UA.',
        maxRps: 300,
        concurrency: 100,
        maxDurationSec: 180,
        profile: 'wave',
        vector: 'http-post',
        agent: 'builtin',
        paths: ['/api/graphql', '/api/search', '/api/login', '/api/cart', '/api/checkout'],
        rotateUa: true,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
    ],
  },
  {
    id: 'threat-ivan-ja4-sweep',
    name: 'Ivan — JA4 fingerprint sweep',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'A baseline, then a gentle, bounded GET sweep that rotates a set of realistic browser ' +
      'User-Agents while carrying an "IvanTest" probe-label header — the bounded shape of ' +
      "Ivan's JA4/TLS fingerprint-enumeration PoC (does the edge classify each browser " +
      'fingerprint consistently, or let some BYPASS?).',
    when: 'Measure how bot-management / JA4 fingerprint classification treats a rotating set of realistic browser fingerprints at a low, bounded rate.',
    threat: {
      technique: 'Browser/TLS (JA4) fingerprint enumeration — Ivan PoC',
      reference:
        "Ivan's JA4/TLS impersonation PoC (curl_cffi browser sweep, 2026-08); JA4+ fingerprinting (FoxIO)",
      measures:
        'Whether JA4 / bot-management classification is consistent across a rotating set of realistic browser fingerprints (e.g. BYPASS vs challenge/block).',
      notReproduced:
        'No TLS ClientHello / JA4 spoofing (the built-in engine sends a normal handshake, so real JA4 impersonation is NOT reproduced) and no volumetric — only a bounded GET sweep rotating benign browser User-Agents plus a probe-label header.',
    },
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady single-fingerprint reference.',
        maxRps: 50,
        concurrency: 10,
        maxDurationSec: 90,
        profile: 'constant',
        agent: 'builtin',
      },
      {
        name: 'Fingerprint sweep',
        summary: 'Gentle bounded sweep rotating browser UAs, carrying the IvanTest probe label.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 150,
        profile: 'constant',
        agent: 'builtin',
        paths: ['/'],
        rotateUa: true,
        headers: {
          'X-Probe-Client': 'IvanTest 1.0',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
    ],
  },
  {
    id: 'threat-ivan-ja4-random',
    name: 'Ivan — JA4 classification (randomized)',
    category: 'Threat-informed',
    drsLevel: 4,
    summary:
      'A single bounded wave that rotates browser User-Agents in bursts while carrying the ' +
      '"IvanTest" probe-label header — the randomized-order variant of Ivan\'s JA4 ' +
      'enumeration, to see whether classification stays stable under a varying fingerprint mix.',
    when: 'Validate that JA4 / fingerprint classification stays stable when realistic browser fingerprints arrive in a randomized, bounded burst pattern.',
    threat: {
      technique: 'Randomized browser/TLS (JA4) fingerprint mix — Ivan PoC',
      reference:
        "Ivan's JA4/TLS impersonation PoC (curl_cffi, random mode, 2026-08); JA4+ fingerprinting (FoxIO)",
      measures:
        'Stability of JA4 / bot classification when a mix of realistic browser fingerprints arrives in a randomized, bounded burst.',
      notReproduced:
        'No TLS ClientHello / JA4 spoofing (normal handshake only) and no volumetric — a bounded GET wave rotating benign User-Agents plus a probe-label header.',
    },
    steps: [
      {
        name: 'Randomized fingerprint wave',
        summary: 'Bounded wave rotating browser UAs, IvanTest probe label.',
        maxRps: 120,
        concurrency: 30,
        maxDurationSec: 150,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/'],
        rotateUa: true,
        headers: {
          'X-Probe-Client': 'IvanTest 1.0',
          'Accept-Language': 'en-US,en;q=0.9',
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
  {
    id: 'pretest-cra-l7',
    name: 'Pre-test — zeroBS L7 playbook (P26-20371)',
    category: 'Threat-informed',
    drsLevel: 5,
    summary:
      'An ordered DRS 3→5 dry-run of the reproducible Layer-7 lines of the zeroBS P26-20371 ' +
      'playbook, so the CRA-platform protection can be rehearsed before the external engagement. ' +
      'Bounded HTTP only. Point it at an AUTHORIZED, allowlisted staging replica — never the ' +
      'ENISA production URLs. Lines not reproduced here (true SlowLoris, HPACK bomb, dedicated ' +
      'WAF-cracker, credential brute-force, and the L3/4 TCP-handshake line) are documented as ' +
      'out of this L7 sequence — the TCP line runs on the isolated class-C bench, not here.',
    when: 'Rehearse the P26-20371 L7 lines against a staging replica before the zeroBS run.',
    threat: {
      technique: 'zeroBS L7 functionality-test sequence (P26-20371)',
      reference: 'zeroBS Playbook P26-20371 — DRS v3, ENISA/CRA portal',
      measures:
        'Whether the WEDOS L7 protection detects and mitigates each DRS 3→5 request-shape ' +
        'instantly (≤ DRS4) without blocking source IPs, measured via detect/mitigate timing, ' +
        'resilience score and collateral on the legitimate probe.',
      notReproduced:
        'No RST_STREAM / stream-cancel abuse, no HPACK decompression bomb, no slow-header ' +
        '(SlowLoris), no credential brute-force — every step is complete, rate-capped requests.',
    },
    companionBench: {
      ladder: 'network-drs345',
      note:
        'The L3/4 half of P26-20371 (Line 1 TCP handshake + the network amplification lines) runs ' +
        'on the isolated class-C bench, not here. Request this synthetic, no-spoof ladder alongside ' +
        'the L7 dry-run for a full-stack DRS 3→5 rehearsal; its verdicts fuse into the WRS read-only.',
    },
    steps: [
      {
        name: 'SlowLoris (DRS3)',
        summary:
          'Line 2 — bounded slow-header hold: 100 connections trickling partial ' +
          'requests; a resilient edge sheds them (request/header timeout).',
        maxRps: 10,
        concurrency: 100,
        maxDurationSec: 120,
        profile: 'constant',
        vector: 'http-slowloris',
        agent: 'builtin',
      },
      {
        name: 'GET-Flood (DRS3)',
        summary: 'Line 3 — steady HTTP GET flood on the main path.',
        maxRps: 400,
        concurrency: 80,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'vegeta',
      },
      {
        name: 'GET-Random-Flood (DRS3)',
        summary: 'Line 4 — waves over non-existent paths; expect edge 404 / origin shielding.',
        maxRps: 500,
        concurrency: 100,
        maxDurationSec: 120,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/nonexistent-a1', '/no/such/page', '/api/does-not-exist', '/random-9f2b'],
      },
      {
        name: 'GET /VALID_RANDOM (DRS4)',
        summary: 'Line 5 — steady load spread over a fixed set of valid paths.',
        maxRps: 500,
        concurrency: 100,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'builtin',
        paths: ['/', '/account', '/api/catalog', '/assets/app.js'],
      },
      {
        name: 'POST-Flood (DRS4)',
        summary: 'Line 6 — bounded HTTP POST load.',
        maxRps: 400,
        concurrency: 80,
        maxDurationSec: 120,
        profile: 'constant',
        vector: 'http-post',
        agent: 'vegeta',
      },
      {
        name: 'HTTP/2 GET-Flood (DRS4)',
        summary: 'Line 7 — high steady rate over h2 (HTTPS target).',
        maxRps: 800,
        concurrency: 150,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'k6',
      },
      {
        name: 'HTTP/2 Rapid Reset — bounded (DRS4)',
        summary: 'Line 8a — h2 request path under sustained bounded rate (no RST_STREAM abuse).',
        maxRps: 800,
        concurrency: 200,
        maxDurationSec: 120,
        profile: 'wave',
        agent: 'k6',
      },
      {
        name: 'HTTP/2 Continuation — header pressure (DRS4)',
        summary: 'Line 8b — h2 requests carrying a larger benign header set (no HPACK bomb).',
        maxRps: 400,
        concurrency: 100,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'k6',
      },
      {
        name: 'Login/account POST-Flood (DRS5)',
        summary: 'Line 9 — bounded POST load on the account/login path (set the path at launch).',
        maxRps: 500,
        concurrency: 120,
        maxDurationSec: 180,
        profile: 'constant',
        vector: 'http-post',
        agent: 'vegeta',
        paths: ['/realms/srp/account'],
      },
      {
        name: 'L7 MultiVector (DRS5)',
        summary: 'Line 10 — mixed paths and rates in one bounded wave.',
        maxRps: 800,
        concurrency: 200,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/', '/account', '/api/catalog', '/search?q=test', '/login'],
        rotateUa: true,
        // Composite 800 rps may exceed a single box's throughput — calibrate so
        // the verdict is a valid measurement, not an under-delivered inconclusive.
        calibrate: true,
      },
      {
        name: 'THOR / PulseWave — synchronized (DRS5)',
        summary: 'Line 11 — synchronized bursts (pulse) rather than a steady rate.',
        maxRps: 1000,
        concurrency: 250,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'k6',
        // A 1000 rps pulse tops a single k6 process's ceiling (~650 rps observed);
        // calibrate to grade the pulse at its real deliverable amplitude.
        calibrate: true,
      },
      {
        name: 'MultiTarget / carpet-bombing (DRS5)',
        summary:
          'Line 13 — spread over many paths of the target. True multi-target = instantiate this ' +
          'playbook once per allowlisted CRA host.',
        maxRps: 800,
        concurrency: 200,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/', '/account', '/portal', '/api/catalog', '/assets/app.js', '/search?q=x'],
        rotateUa: true,
        // Composite 800 rps may exceed a single box's throughput — calibrate.
        calibrate: true,
      },
    ],
  },
  {
    id: 'xlayer-full-assurance',
    name: 'Cross-layer full assurance (L7 + class-C DRS 3→5)',
    category: 'Threat-informed',
    drsLevel: 5,
    summary:
      'One template pairing a compact bounded-L7 DRS 3→5 line-set (run here) with the synthetic, ' +
      'no-spoof class-C network ladder (run on the isolated bench). The two fuse into a single ' +
      'full-stack WRS: class A/B (application) + class C (network), read-only. Point the L7 side ' +
      'at an AUTHORIZED, allowlisted replica; the class-C side never runs in the control plane.',
    when: 'For a full-stack (L7 + L3/4) resilience rehearsal in one pass.',
    threat: {
      technique: 'Cross-layer bounded L7 + synthetic class-C network shapes',
      reference: 'Composed from P26-20371 (L7) + the class-C network bench ladder',
      measures:
        'Whether protection holds across BOTH the application request path (L7, tested here) and ' +
        'the network edge (L3/4 amplification + connection pressure, on the isolated bench), fused ' +
        'into one DRS 3→5 view.',
      notReproduced:
        'No spoofing, no raw packet crafting, no real reflector — the class-C side is synthetic and ' +
        'runs only on the isolated bench.',
    },
    companionBench: {
      ladder: 'network-drs345',
      note: 'The class-C half — request it alongside the L7 steps for the fused full-stack verdict.',
    },
    steps: [
      {
        name: 'GET-Flood (DRS3)',
        summary: 'Steady HTTP GET flood on the main path.',
        maxRps: 400,
        concurrency: 80,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'vegeta',
      },
      {
        name: 'POST-Flood (DRS4)',
        summary: 'Bounded HTTP POST load — dynamic/compute pressure.',
        maxRps: 400,
        concurrency: 80,
        maxDurationSec: 120,
        profile: 'constant',
        vector: 'http-post',
        agent: 'vegeta',
      },
      {
        name: 'HTTP/2 GET-Flood (DRS4)',
        summary: 'High steady rate over h2 (HTTPS target).',
        maxRps: 800,
        concurrency: 150,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'k6',
      },
      {
        name: 'L7 MultiVector (DRS5)',
        summary: 'Mixed paths and rates in one bounded wave.',
        maxRps: 800,
        concurrency: 200,
        maxDurationSec: 180,
        profile: 'wave',
        agent: 'builtin',
        paths: ['/', '/account', '/api/catalog', '/search?q=test', '/login'],
        rotateUa: true,
        calibrate: true,
      },
    ],
  },
  {
    // Adjacent bounded L7 scenarios derived from the 2026-09-12 bank.cz run
    // analysis: the two mechanisms that passed on the (unprotected) origin were
    // dynamic/POST compute (origin 5xx + latency collapse) and connection
    // concurrency. Each line probes an adjacent request-shape and maps to the
    // mitigation it would validate once WEDOS Protection fronts the target.
    id: 'bankcz-connexes',
    name: 'bank.cz L7 — connexes (hypotheses)',
    category: 'Threat-informed',
    drsLevel: 5,
    summary:
      'Adjacent bounded L7 lines derived from what already stressed the unprotected bank.cz ' +
      'origin: dynamic/POST compute (5xx + latency) and connection concurrency. Each maps to a ' +
      'mitigation it would validate. Bounded HTTP only, allowlisted, tagged, kill-switchable. ' +
      'Endpoints are seeded automatically from a recon of the target at launch (off-surface paths ' +
      'are dropped, so no 404 floods); the sequence escalates to the peak concurrency line last.',
    when: 'After the P26-20371 dry-run, to probe adjacent shapes and validate mitigations.',
    threat: {
      technique: 'Adjacent L7 request-shapes (dynamic-compute + connection concurrency)',
      reference: 'Derived from the 2026-09-12 bank.cz proving-ground run analysis',
      measures:
        'Whether the two mechanisms that passed (POST/dynamic → origin 5xx & latency; high ' +
        'concurrency → connection backlog) also pass under adjacent shapes, and whether a ' +
        'rate-limit / bot-challenge / concurrency-cap / cache would neutralise them.',
      notReproduced:
        'No credential brute-force, no RST_STREAM / HPACK abuse, no slow-header beyond a bounded ' +
        'connection hold — every step is complete, rate-capped requests within HARD_CAPS.',
    },
    steps: [
      {
        name: 'Search/query flood — random terms (A)',
        summary:
          'Line A1 — uncacheable GET search over varied query terms; hits DB/full-text on the ' +
          'origin, like the login POST. Validates: rate-limit + query-cost caps on search.',
        maxRps: 500,
        concurrency: 150,
        maxDurationSec: 180,
        profile: 'constant',
        vector: 'http-get',
        agent: 'builtin',
        paths: [
          '/search?q=alpha',
          '/search?q=bravo',
          '/search?q=charlie',
          '/search?q=delta',
          '/search?q=echo',
        ],
      },
      {
        name: 'Password-reset / register POST-flood (A)',
        summary:
          'Line A2 — bounded POST on auth-adjacent write endpoints (heavier than login: token, ' +
          'e-mail, DB write). Validates: rate-limit + challenge on auth POST.',
        maxRps: 400,
        concurrency: 100,
        maxDurationSec: 180,
        profile: 'constant',
        vector: 'http-post',
        agent: 'builtin',
        paths: ['/password-reset', '/account/recover', '/register'],
      },
      {
        name: 'Endpoint-mix POST — weighted (A)',
        summary:
          'Line A3 — POST spread across several dynamic endpoints so a per-path throttle is ' +
          'evaded; total origin compute stays high. Validates: a GLOBAL (not per-path) rate-limit.',
        maxRps: 600,
        concurrency: 150,
        maxDurationSec: 180,
        profile: 'wave',
        vector: 'http-post',
        agent: 'builtin',
        rotateUa: true,
        paths: ['/login', '/account', '/contact', '/api/submit'],
      },
      {
        name: 'Auth session pressure (A)',
        summary:
          'Line A4 — POST pressure on login/account with UA rotation to mimic many sessions; for ' +
          'a true GET→POST→GET flow with think-time, build it in the campaign flow editor. ' +
          'Validates: bot challenge / ATP + session-aware rate-limit.',
        maxRps: 300,
        concurrency: 120,
        maxDurationSec: 180,
        profile: 'constant',
        vector: 'http-post',
        agent: 'builtin',
        rotateUa: true,
        paths: ['/login', '/account'],
      },
      {
        name: 'POST-flood in pulses (A)',
        summary:
          'Line A5 — the login POST delivered in synchronized bursts; pulses at the window reset ' +
          'beat a FIXED-window rate-limit. Validates: a sliding-window rate-limit.',
        maxRps: 600,
        concurrency: 150,
        maxDurationSec: 180,
        profile: 'wave',
        vector: 'http-post',
        agent: 'builtin',
        paths: ['/login'],
      },
      {
        name: 'Cache-buster GET — future-CDN bypass',
        summary:
          'Line C1 — GET on the main path with a unique query per variant so a CDN cannot serve ' +
          'it; harmless on the bare origin today, becomes the CDN-bypass test once a cache is ' +
          'added. Validates: cache-key policy + micro-cache.',
        maxRps: 800,
        concurrency: 150,
        maxDurationSec: 120,
        profile: 'constant',
        vector: 'http-get',
        agent: 'builtin',
        paths: ['/?_=a1', '/?_=b2', '/?_=c3', '/?_=d4'],
      },
      {
        name: 'Slow connection hold — bounded (B)',
        summary:
          'Line B2 — many connections held with trickled requests (bounded slow-header, no true ' +
          'SlowLoris abuse); exhausts the connection pool without volume. Validates: request/' +
          'header timeout + slow-body protection.',
        maxRps: 10,
        concurrency: 300,
        maxDurationSec: 300,
        profile: 'constant',
        vector: 'http-slowloris',
        agent: 'builtin',
      },
      {
        // Peak disruption — deliberately LAST in the escalation.
        name: 'Sustained max-concurrency GET (B)',
        summary:
          'Line B1 — moderate rate but a high concurrent connection hold (THOR dropped the probe ' +
          'to 40% at 250 conns). Validates: edge→origin concurrency cap + connection draining. ' +
          'Isolate the legitimate probe when running this so the verdict is attributable.',
        maxRps: 300,
        concurrency: 400,
        maxDurationSec: 300,
        profile: 'constant',
        vector: 'http-get',
        agent: 'builtin',
      },
    ],
  },
  {
    id: 'bankcz-breaker',
    name: 'bank.cz breaker — all levers (demo)',
    category: 'Threat-informed',
    drsLevel: 5,
    summary:
      'The single scenario that stages every delivery lever at once against the unprotected ' +
      'bank.cz origin, escalating to the one shape that actually degrades it. A paired GET ' +
      'control vs. cache-busted GET makes the cache-bypass delta visible, then the POST · dynamic ' +
      'endpoints ⚡ · cache-bust · no-keep-alive · parallel-generation line drives the origin past ' +
      'its breaking point. Endpoints are recon-seeded at launch (off-surface paths dropped, no 404 ' +
      'floods). Bounded HTTP only, allowlisted, tagged, kill-switchable — the levers change only ' +
      'HOW the same capped requests are delivered, never the volume.',
    when: 'For a demo / before-after: to show, in one suite, which lever each defense would neutralise.',
    threat: {
      technique:
        'Combined L7 delivery levers (dynamic POST + cache-bypass + connection churn + parallel gen)',
      reference:
        'Derived from the 2026-09-12 bank.cz proving-ground run (POST @400rps → ~50% avail, WRS 66)',
      measures:
        'Which delivery lever each defense removes: whether a cache-key policy absorbs the ' +
        'cache-busted GET, whether a connection-accept / keep-alive cap blunts the no-keep-alive ' +
        'churn, and whether a global rate-limit + bot-challenge on dynamic POST neutralises the ' +
        'one line that reaches the origin compute path.',
      notReproduced:
        'No spoofing, no protocol abuse (RST_STREAM / HPACK / slow-header beyond a bounded hold), ' +
        'no credential brute-force — every step is complete, rate-capped requests within HARD_CAPS; ' +
        'parallelism only splits the SAME offered rate across workers so a single box can sustain it.',
    },
    steps: [
      {
        name: 'Baseline — pre-load health',
        summary:
          'Low-rate GET to establish the origin is healthy before load, so the breaker line has a ' +
          'clean before/after reference.',
        maxRps: 20,
        concurrency: 5,
        maxDurationSec: 20,
        profile: 'constant',
        vector: 'http-get',
        agent: 'builtin',
      },
      {
        name: 'GET control — cacheable (absorbed)',
        summary:
          'Plain GET on the main path, no levers. On a bare origin it is absorbed; once a CDN/cache ' +
          'is added this is the line the edge should serve. The "before" half of the cache-bypass ' +
          'delta — compare its availability with the next step.',
        maxRps: 500,
        concurrency: 150,
        maxDurationSec: 90,
        profile: 'constant',
        vector: 'http-get',
        agent: 'builtin',
        paths: ['/'],
      },
      {
        name: 'GET cache-bypass — unique per request ⚡',
        summary:
          'Same GET and rate, but every request is unique (cache-bust) over fresh connections ' +
          '(no keep-alive), split across parallel workers. A cache/CDN cannot absorb it — each ' +
          'request reaches origin — and the connection-accept path is exercised too. The "after" ' +
          'half of the delta. Validates: cache-key policy + connection/keep-alive cap.',
        maxRps: 500,
        concurrency: 150,
        maxDurationSec: 90,
        profile: 'constant',
        vector: 'http-get',
        agent: 'vegeta',
        paths: ['/'],
        cacheBust: true,
        noKeepAlive: true,
        parallelism: 3,
      },
      {
        // Peak disruption — deliberately LAST in the escalation.
        name: 'POST breaker — dynamic endpoints, all levers',
        summary:
          'The breaker: bounded POST spread across dynamic (DB/compute) endpoints so a per-path ' +
          'throttle is evaded, delivered cache-busted over fresh connections and split across ' +
          'parallel workers, in pulses to beat a fixed-window limit. This is the shape that took ' +
          'the unprotected origin to ~50% availability (WRS 66). Validates: a GLOBAL rate-limit + ' +
          'bot-challenge on dynamic POST. Isolate the legitimate probe so the verdict is attributable.',
        maxRps: 400,
        concurrency: 200,
        maxDurationSec: 180,
        profile: 'wave',
        vector: 'http-post',
        agent: 'vegeta',
        rotateUa: true,
        paths: ['/login', '/api/search', '/password-reset', '/api/checkout'],
        cacheBust: true,
        noKeepAlive: true,
        parallelism: 4,
      },
    ],
  },
  {
    id: 'full-review',
    name: 'Full review — escalating (curated)',
    category: 'Review',
    summary:
      'One curated pass over every bounded vector — a single baseline, escalating GET and POST, ' +
      'endpoint mix, cache-buster, slow-hold, max-concurrency, real HTTP/2 and a synchronized ' +
      'pulse — with no redundant repeats. The lean alternative to composing every template.',
    when: 'A single comprehensive resilience review (~30 min) instead of a 60+ step template mix.',
    steps: [
      {
        name: 'Baseline',
        summary: 'Steady reference load — one, reused for the whole review.',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        profile: 'constant',
        agent: 'vegeta',
      },
      {
        name: 'GET capacity ramp',
        summary: 'Rising GET to find the knee where absorption degrades.',
        maxRps: 800,
        concurrency: 150,
        maxDurationSec: 180,
        profile: 'ramp',
        vector: 'http-get',
        agent: 'vegeta',
      },
      {
        name: 'GET endpoint-mix (recon surface)',
        summary: 'GET spread over the real seeded paths, not just the root.',
        maxRps: 500,
        concurrency: 100,
        maxDurationSec: 150,
        profile: 'constant',
        vector: 'http-get',
        paths: ['/', '/search?q=test', '/api/products', '/login', '/account'],
        agent: 'vegeta',
      },
      {
        name: 'Cache-buster GET',
        summary: 'A unique query per request so the origin cannot serve from cache.',
        maxRps: 700,
        concurrency: 150,
        maxDurationSec: 120,
        profile: 'constant',
        vector: 'http-get',
        paths: ['/?_=a', '/?_=b', '/?_=c', '/?_=d'],
        agent: 'vegeta',
      },
      {
        name: 'POST escalation (break point)',
        summary: 'Rising POST — the dynamic path with no cache headroom (the usual break point).',
        maxRps: 600,
        concurrency: 150,
        maxDurationSec: 180,
        profile: 'ramp',
        vector: 'http-post',
        agent: 'vegeta',
      },
      {
        name: 'Auth/login POST pressure',
        summary: 'Bounded POST on auth-adjacent write endpoints.',
        maxRps: 400,
        concurrency: 100,
        maxDurationSec: 150,
        profile: 'constant',
        vector: 'http-post',
        paths: ['/login', '/password-reset', '/register'],
        agent: 'vegeta',
      },
      {
        name: 'Slow connection hold (bounded)',
        summary: 'Hold many slow connections — does the origin shed incomplete requests?',
        maxRps: 10,
        concurrency: 200,
        maxDurationSec: 180,
        profile: 'constant',
        vector: 'http-slowloris',
        agent: 'builtin',
      },
      {
        name: 'Sustained max-concurrency GET',
        summary: 'High concurrency at a bounded rate — connection-pool pressure.',
        maxRps: 400,
        concurrency: 400,
        maxDurationSec: 180,
        profile: 'constant',
        vector: 'http-get',
        agent: 'vegeta',
      },
      {
        name: 'HTTP/2 request burst',
        summary: 'Bounded high-rate load over real HTTP/2 (k6 negotiates h2 on HTTPS).',
        maxRps: 800,
        concurrency: 150,
        maxDurationSec: 120,
        profile: 'constant',
        vector: 'http-get',
        agent: 'k6',
      },
      {
        name: 'Synchronized pulse (THOR-shape)',
        summary: 'On/off waves to test burst absorption and any auto-scaling.',
        maxRps: 900,
        concurrency: 200,
        maxDurationSec: 180,
        profile: 'wave',
        vector: 'http-get',
        agent: 'k6',
      },
      {
        name: 'Multi-vector wave',
        summary: 'A high-concurrency wave spread over the surface — the closing stress.',
        maxRps: 700,
        concurrency: 200,
        maxDurationSec: 180,
        profile: 'wave',
        vector: 'http-get',
        paths: ['/', '/api/products', '/cart', '/search?q=a', '/checkout'],
        agent: 'vegeta',
      },
    ],
  },
  {
    id: 'origin-l7-exhaustion',
    name: 'Bare-origin L7 exhaustion',
    category: 'Threat-informed',
    drsLevel: 3,
    summary:
      'An escalating GET then POST flood on the target’s dynamic (uncacheable) surface with a ' +
      'fresh connection per request — the bounded profile that overflows an unprotected origin’s ' +
      'worker / accept backlog until it sheds legitimate traffic. A protected edge absorbs it; a ' +
      'bare origin collapses.',
    when:
      'Find an unprotected origin’s breaking point, or run before/after placing a protection ' +
      '(CDN / WAF / rate-limit) in front of it to quantify the gain. Meaningful against a target ' +
      'with an uncacheable dynamic endpoint — recon seeds the paths at launch.',
    threat: {
      technique:
        'Volumetric L7 request flood on origin-served (uncacheable) endpoints with connection ' +
        'churn (no keep-alive) — commodity “origin exhaustion”.',
      reference:
        'Generic HTTP flood / origin resource exhaustion; validated on the WEDOS bare-origin ' +
        'benchmark (2026-09-16).',
      measures:
        'Whether the edge absorbs / throttles the flood (protection working) or it reaches and ' +
        'exhausts the origin’s worker pool (availability collapse). On the bare benchmark, ' +
        'availability fell 100% → ~10% once the offered rate crossed ~1.5× the origin service rate.',
      notReproduced:
        'No amplification, no source spoofing, no unbounded exhaustion — every step is rate / ' +
        'concurrency / duration capped by HARD_CAPS.',
    },
    steps: [
      {
        name: 'GET — breaking point (minimal)',
        summary:
          'Just above the origin service rate; fresh connections overflow the backlog into 5xx.',
        maxRps: 150,
        concurrency: 500,
        maxDurationSec: 60,
        profile: 'constant',
        vector: 'http-get',
        cacheBust: true,
        noKeepAlive: true,
      },
      {
        name: 'GET — full collapse',
        summary: 'Several times the service rate — sustained 5xx, availability floors out.',
        maxRps: 400,
        concurrency: 500,
        maxDurationSec: 60,
        profile: 'constant',
        vector: 'http-get',
        cacheBust: true,
        noKeepAlive: true,
      },
      {
        name: 'POST — full collapse',
        summary: 'POST variant against the same dynamic surface — same origin bottleneck.',
        maxRps: 400,
        concurrency: 500,
        maxDurationSec: 60,
        profile: 'constant',
        vector: 'http-post',
        cacheBust: true,
        noKeepAlive: true,
      },
    ],
  },
];

// Each reproducible zeroBS P26-20371 L7 line, exposed as its OWN single-step
// playbook, so an operator can replay any one line on its own — not only the
// full 12-step sequence. Derived from the parent `pretest-cra-l7` steps so the
// two can never drift: edit the parent, the single-line templates follow.
const ZEROBS_PARENT_ID = 'pretest-cra-l7';

function lineSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(drs\d\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** The single-step template id for a zeroBS L7 line (used by the gap planner to
 *  turn a recommended line into a composable/replayable campaign). */
export function zeroBsLineTemplateId(stepName: string): string {
  return `cra-l7-${lineSlug(stepName)}`;
}
function drsOfName(name: string): number | undefined {
  const m = name.match(/DRS\s*([1-7])/i);
  return m ? Number(m[1]) : undefined;
}

const ZEROBS_LINE_PLAYBOOKS: Playbook[] = (() => {
  const parent = CURATED_PLAYBOOKS.find((p) => p.id === ZEROBS_PARENT_ID);
  if (!parent) return [];
  return parent.steps.map((step) => ({
    id: `cra-l7-${lineSlug(step.name)}`,
    name: `zeroBS L7 — ${step.name}`,
    category: 'zeroBS L7 lines (P26-20371)',
    drsLevel: drsOfName(step.name) ?? parent.drsLevel,
    summary: step.summary,
    when:
      'Replay this single zeroBS P26-20371 L7 line on its own against an authorized, ' +
      'allowlisted staging replica — never the ENISA production URLs.',
    threat: parent.threat,
    steps: [step],
  }));
})();

/**
 * When each curated template was introduced (date the template first shipped,
 * from git history). Documentation/UX only — it never changes what is sent. The
 * zeroBS single-line templates share the date they were split out (see below).
 */
const CURATED_CREATED_AT: Record<string, string> = {
  'quick-readiness': '2026-09-05',
  'capacity-assessment': '2026-09-05',
  endurance: '2026-09-05',
  'burst-resilience': '2026-09-06',
  'threat-l7-signature-evasion': '2026-09-06',
  'threat-http2-burst': '2026-09-06',
  'threat-cache-key-stress': '2026-09-06',
  'threat-url-allowlist': '2026-09-07',
  'threat-method-policy': '2026-09-07',
  'threat-l7-multivector': '2026-09-07',
  'threat-iot-botnet': '2026-09-07',
  'threat-ramp-plateau': '2026-09-07',
  'threat-sync-pulse': '2026-09-07',
  'threat-chaos': '2026-09-07',
  'threat-header-fingerprint': '2026-09-07',
  'threat-http2-continuation': '2026-09-07',
  'threat-madeyoureset': '2026-09-07',
  'threat-aisuru-botnet': '2026-09-07',
  'pretest-cra-l7': '2026-09-08',
  'threat-micro-burst-train': '2026-09-11',
  'threat-ransom-demo': '2026-09-11',
  'threat-api-post-storm': '2026-09-11',
  'threat-ivan-ja4-sweep': '2026-09-11',
  'threat-ivan-ja4-random': '2026-09-11',
  'bankcz-connexes': '2026-09-12',
  'bankcz-breaker': '2026-09-13',
  'full-review': '2026-09-13',
  'xlayer-full-assurance': '2026-09-15',
  'origin-l7-exhaustion': '2026-09-16',
};
/** Date the zeroBS L7 lines were split into their own single-step templates. */
const ZEROBS_LINES_CREATED_AT = '2026-09-11';
const toIso = (d: string): string => `${d}T00:00:00.000Z`;

/**
 * The full playbook library: the curated multi-step scenarios plus one
 * single-step template per zeroBS L7 line (each independently replayable). Each
 * template is stamped with its introduction date (`createdAt`).
 */
export const PLAYBOOKS: Playbook[] = [
  ...CURATED_PLAYBOOKS.map((p) => ({
    ...p,
    createdAt: CURATED_CREATED_AT[p.id] ? toIso(CURATED_CREATED_AT[p.id]) : undefined,
  })),
  ...ZEROBS_LINE_PLAYBOOKS.map((p) => ({ ...p, createdAt: toIso(ZEROBS_LINES_CREATED_AT) })),
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
  /**
   * Optional real published surface from a recon of the target. When present,
   * each step's TEMPLATED paths are seeded against it (see `seedPaths`) so a
   * suite hits real endpoints instead of flooding non-existent ones (404).
   */
  recon?: ReconSurface;
}

/** The recon-derived surface used to seed playbook paths. */
export interface ReconSurface {
  /** Real paths found on the target's published surface. */
  paths: string[];
  /** Best-guess login / account path, if one surfaced. */
  loginPath?: string;
}

/** A path minus its query string (`/search?q=x` → `/search`). */
function basePath(p: string): string {
  const q = p.indexOf('?');
  return q === -1 ? p : p.slice(0, q);
}

/** Auth-adjacent intent in a templated path — substituted with the real login path. */
const AUTH_INTENT = /login|account|password|register|recover|signin|auth/i;

/**
 * Resolves a step's TEMPLATED paths against a real published surface from recon:
 * keeps paths whose base is on the surface, substitutes the discovered login /
 * account path for auth-intent paths, drops off-surface paths, and falls back to
 * the root when nothing is left — so a recon-seeded suite never floods 404s.
 * Pure. Returns the paths unchanged when no recon surface is supplied.
 */
export function seedPaths(paths: string[] | undefined, recon?: ReconSurface): string[] | undefined {
  if (!paths?.length || !recon) return paths;
  const surface = new Set(recon.paths.map(basePath));
  const out: string[] = [];
  for (const p of paths) {
    const base = basePath(p);
    if (AUTH_INTENT.test(base) && recon.loginPath) {
      out.push(recon.loginPath);
    } else if (surface.has(base)) {
      out.push(p);
    }
    // else: off the published surface → dropped (would only 404).
  }
  const unique = [...new Set(out)];
  return unique.length ? unique : ['/'];
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
  return playbook.steps.map((step, i) =>
    campaignInputFromStep(step, {
      // A single-step playbook's one campaign is just the playbook name (its
      // name already carries the line); multi-step suites keep the step suffix.
      name: playbook.steps.length === 1 ? playbook.name : `${playbook.name} — ${step.name}`,
      suiteId,
      suiteName: playbook.name,
      suiteOrder: i,
      t,
      engines,
    }),
  );
}

/**
 * Composes several playbooks into ONE suite: their steps are concatenated in
 * template order under a single shared suiteId, so the result behaves exactly
 * like any other suite (sequencer, aggregate WRS, one assessment report). Each
 * step's name is prefixed with its source template so provenance stays visible
 * (the suite name is the composite's, not any single playbook's). Governance is
 * unchanged — every campaign still goes through approval + caps individually.
 */
/** A "baseline" step: a low-rate single measurement a template runs to establish
 *  the target's pre-load health. In a composite each template contributes one,
 *  so a 26-template mix carries ~18 identical baselines. */
export function isBaselineStep(step: { name: string }): boolean {
  return /\bbaseline\b/i.test(step.name);
}

export function buildCompositeSuite(
  playbooks: Playbook[],
  suiteName: string,
  t: SuiteTarget,
  engines: EngineAvailability[] = [],
): CampaignInput[] {
  const suiteId = randomUUID();
  const inputs: CampaignInput[] = [];
  let order = 0;
  // Dedupe baselines across the composite: keep the FIRST, drop every subsequent
  // per-template baseline. Each run already captures its own probe baseline and
  // the recovery gate re-checks target health between steps, so the repeated
  // baseline steps are pure redundancy (~35 min of wasted load on a big mix).
  let seenBaseline = false;
  for (const pb of playbooks) {
    for (const step of pb.steps) {
      if (isBaselineStep(step)) {
        if (seenBaseline) continue;
        seenBaseline = true;
      }
      // Prefix with the source template name so a composed step reads e.g.
      // "GET flood readiness — Ramp" even though the suite name is the mix's.
      const name = pb.steps.length === 1 ? pb.name : `${pb.name} — ${step.name}`;
      inputs.push(
        campaignInputFromStep(step, { name, suiteId, suiteName, suiteOrder: order, t, engines }),
      );
      order += 1;
    }
  }
  return inputs;
}

/** Maps one playbook step to a CampaignInput bound into a suite. */
function campaignInputFromStep(
  step: PlaybookStep,
  o: {
    name: string;
    suiteId: string;
    suiteName: string;
    suiteOrder: number;
    t: SuiteTarget;
    engines: EngineAvailability[];
  },
): CampaignInput {
  const isAvailable = (id?: string): boolean =>
    id != null && o.engines.some((e) => e.id === id && e.available);
  let origin = o.t.target;
  try {
    origin = new URL(o.t.target).origin;
  } catch {
    /* keep raw; createCampaign will reject an invalid target */
  }
  const agent = isAvailable(step.agent) ? step.agent : undefined;
  // Custom per-step headers are attached only for the built-in engine (explicit
  // or default). UA rotation is handled separately below — vegeta rotates it too.
  const builtin = agent === 'builtin' || agent === undefined;
  // Seed the step's templated paths against the target's real surface (when a
  // recon was supplied) so path-based lines hit real endpoints, not 404s. The
  // seeded endpoints attach for EVERY engine — the out-of-process engines
  // (vegeta/k6) honour a multi-target endpoint set too, so a recon-seeded step
  // hits the real surface whatever engine runs it (not just the built-in one).
  const seededPaths = seedPaths(step.paths, o.t.recon);
  const endpoints = seededPaths?.length
    ? seededPaths.map((p) => ({ url: `${origin}${p}` }))
    : undefined;
  // UA rotation is honoured by the built-in engine AND by vegeta (which spreads
  // the set across its targets file), so attach it for either — and for the
  // default/unspecified engine, which auto-routes to vegeta at high rate. A
  // built-in-pinned high-rate line auto-routes to vegeta at run time now that
  // UA rotation no longer forces built-in (engine-route.ts), so the DRS5
  // composite lines finally deliver their configured rate instead of ~150 rps.
  // (k6 does not yet rotate UAs; a k6-pinned step would silently drop them.)
  const uaRotationCapable = agent === 'builtin' || agent === 'vegeta' || agent === undefined;
  const userAgents = uaRotationCapable && step.rotateUa ? DEFAULT_UA_SET : undefined;
  const headers = builtin && step.headers ? step.headers : undefined;
  // Delivery levers travel with the step regardless of engine: cache-busting and
  // no-keep-alive are honoured by the built-in generator and by vegeta/k6, and
  // parallelism is a vegeta fan-out (clamped downstream). They only shape HOW the
  // same bounded, allowlisted, capped requests are delivered — never the volume.
  return {
    name: o.name,
    description: step.summary,
    target: o.t.target,
    vector: step.vector ?? 'http-get',
    maxRps: step.maxRps,
    concurrency: step.concurrency,
    maxDurationSec: step.maxDurationSec,
    probeUrl: o.t.probeUrl,
    createdBy: o.t.createdBy,
    authorized: true,
    scenario: buildScenario(step.profile, step.maxRps, step.maxDurationSec),
    agent,
    endpoints,
    userAgents,
    headers,
    cacheBust: step.cacheBust,
    noKeepAlive: step.noKeepAlive,
    parallelism: step.parallelism,
    calibrate: step.calibrate,
    recurrence: o.t.recurrenceMin ? { intervalMin: o.t.recurrenceMin } : undefined,
    suiteId: o.suiteId,
    suiteName: o.suiteName,
    suiteOrder: o.suiteOrder,
  };
}
