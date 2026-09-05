import { randomUUID } from 'node:crypto';
import { HARD_CAPS } from '../campaigns/model.js';
import type { CampaignInput, ScenarioPhase } from '../campaigns/model.js';

export class PlaybookError extends Error {}

/**
 * Assessment playbooks: curated, ordered sequences of BOUNDED campaigns that
 * together form a resilience assessment (the "one-click assessment" idea, done
 * safely). A playbook sets load shapes only — never a target — and every
 * campaign it produces still goes through approval and the caps. No attack
 * vector: each step is the same bounded HTTP generator as everywhere else.
 */

export type LoadProfile = 'constant' | 'ramp' | 'wave';

export interface PlaybookStep {
  name: string;
  summary: string;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  profile: LoadProfile;
  /** Preferred engine (applied when installed, else the server default). */
  agent?: string;
}

export interface Playbook {
  id: string;
  name: string;
  category: string;
  summary: string;
  /** When to run this assessment. */
  when: string;
  steps: PlaybookStep[];
  /** true for user-defined playbooks (curated ones are read-only). */
  custom?: boolean;
}

const PROFILES = ['constant', 'ramp', 'wave'];
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
    return {
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : label,
      summary: typeof s.summary === 'string' ? s.summary : '',
      maxRps,
      concurrency,
      maxDurationSec,
      profile: profile as LoadProfile,
      agent: typeof s.agent === 'string' && s.agent ? s.agent : undefined,
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
  return playbook.steps.map((step, i) => ({
    name: `${playbook.name} — ${step.name}`,
    description: step.summary,
    target: t.target,
    vector: 'http-get',
    maxRps: step.maxRps,
    concurrency: step.concurrency,
    maxDurationSec: step.maxDurationSec,
    probeUrl: t.probeUrl,
    createdBy: t.createdBy,
    authorized: true,
    scenario: buildScenario(step.profile, step.maxRps, step.maxDurationSec),
    agent: isAvailable(step.agent) ? step.agent : undefined,
    suiteId,
    suiteName: playbook.name,
    suiteOrder: i,
  }));
}
