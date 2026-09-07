import { PRESETS, estimatedRequests } from './presets.js';
import type { Preset } from './presets.js';
import type { HardCaps, Playbook, WrsSeries } from './api.js';

/**
 * The new-campaign journey is objective-first: the operator says what they want
 * to learn, and we recommend the best-fit template (a single preset test or a
 * full assessment playbook), ranked by what's actually runnable right now —
 * installed engines, the effective operational caps, and the target's own WRS
 * history. This module is pure (no React, no fetch) so it is easy to test.
 */

export interface Objective {
  id: string;
  icon: string;
  /** Short card title. */
  title: string;
  /** First-person framing shown under the title. */
  question: string;
  blurb: string;
  /** Preset ids that fit this objective (single-test path), gentlest first. */
  presetIds: string[];
  /** Playbook category that fits (assessment-suite path). */
  playbookCategory?: string;
  /** Specific playbook ids to prefer (assessment-suite path), in order. */
  playbookIds?: string[];
  /** Which path the objective leans toward by default. */
  defaultMode: 'single' | 'suite';
}

export const OBJECTIVES: Objective[] = [
  {
    id: 'readiness',
    icon: '🩺',
    title: 'Readiness',
    question: 'Is the target testable and healthy?',
    blurb: 'A tiny smoke test, then a short baseline. Start here on a new target.',
    presetIds: ['smoke', 'baseline'],
    playbookIds: ['quick-readiness'],
    defaultMode: 'single',
  },
  {
    id: 'capacity',
    icon: '📈',
    title: 'Capacity',
    question: 'How much sustained load can it take?',
    blurb: 'Baseline, then a ramp to find the knee, then a high steady ceiling.',
    presetIds: ['baseline', 'ramp', 'ceiling'],
    playbookIds: ['capacity-assessment'],
    defaultMode: 'suite',
  },
  {
    id: 'burst',
    icon: '💥',
    title: 'Spike resilience',
    question: 'Does it survive a sudden spike?',
    blurb: 'Alternating bursts and lulls — how protection and autoscaling react and recover.',
    presetIds: ['spike'],
    playbookIds: ['burst-resilience', 'threat-sync-pulse'],
    defaultMode: 'single',
  },
  {
    id: 'threat',
    icon: '🛡️',
    title: 'Threat-informed',
    question: 'Will my protection catch a modern attack shape?',
    blurb:
      'Bounded replays of current L7 attack shapes (DRS 3–5) — WAF, rate-limit, bot management.',
    presetIds: [],
    playbookCategory: 'Threat-informed',
    defaultMode: 'suite',
  },
  {
    id: 'endurance',
    icon: '⏳',
    title: 'Endurance',
    question: 'Any slow degradation over time?',
    blurb: 'A long, gentle soak to reveal leaks or creeping resource exhaustion.',
    presetIds: ['soak'],
    playbookIds: ['endurance'],
    defaultMode: 'single',
  },
];

export function getObjective(id: string): Objective | undefined {
  return OBJECTIVES.find((o) => o.id === id);
}

/** A unified template: either a single-run preset or an assessment playbook. */
export type Template =
  | { kind: 'preset'; id: string; preset: Preset }
  | { kind: 'playbook'; id: string; playbook: Playbook };

export function templateName(t: Template): string {
  return t.kind === 'preset' ? t.preset.name : t.playbook.name;
}
export function templateIcon(t: Template): string {
  return t.kind === 'preset' ? t.preset.icon : '🧩';
}
export function templateSummary(t: Template): string {
  return t.kind === 'preset' ? t.preset.summary : t.playbook.summary;
}
export function templateEngine(t: Template): string | undefined {
  return t.kind === 'preset' ? t.preset.recommendedAgent : t.playbook.steps[0]?.agent;
}
export function drsLevel(t: Template): number | undefined {
  return t.kind === 'playbook' ? t.playbook.drsLevel : undefined;
}
/** Number of runs the template produces (1 for a preset, N steps for a playbook). */
export function stepCount(t: Template): number {
  return t.kind === 'preset' ? 1 : t.playbook.steps.length;
}

/** Highest instantaneous rate the template asks for. */
export function peakRps(t: Template): number {
  if (t.kind === 'preset') return t.preset.maxRps;
  return Math.max(0, ...t.playbook.steps.map((s) => s.maxRps));
}
export function peakConcurrency(t: Template): number {
  if (t.kind === 'preset') return t.preset.concurrency;
  return Math.max(0, ...t.playbook.steps.map((s) => s.concurrency));
}
/** Total wall-clock the template runs for (sum of steps for a playbook). */
export function totalDurationSec(t: Template): number {
  if (t.kind === 'preset') return t.preset.maxDurationSec;
  return t.playbook.steps.reduce((a, s) => a + s.maxDurationSec, 0);
}
/** Indicative total requests emitted (accounts for each phase's average rate). */
export function estRequests(t: Template): number {
  if (t.kind === 'preset') {
    return estimatedRequests(t.preset.maxRps, t.preset.maxDurationSec, t.preset.profile);
  }
  return t.playbook.steps.reduce(
    (a, s) => a + estimatedRequests(s.maxRps, s.maxDurationSec, s.profile),
    0,
  );
}

/** True iff every phase of the template fits inside the effective caps. */
export function withinCaps(t: Template, caps: HardCaps): boolean {
  return (
    peakRps(t) <= caps.maxRps &&
    peakConcurrency(t) <= caps.maxConcurrency &&
    (t.kind === 'preset'
      ? t.preset.maxDurationSec <= caps.maxDurationSec
      : t.playbook.steps.every((s) => s.maxDurationSec <= caps.maxDurationSec))
  );
}

/** Which effective cap a template would breach (for a precise, honest hint). */
export function capBreach(t: Template, caps: HardCaps): string | null {
  if (peakRps(t) > caps.maxRps) return `peak ${peakRps(t)} rps > limit ${caps.maxRps}`;
  if (peakConcurrency(t) > caps.maxConcurrency)
    return `concurrency ${peakConcurrency(t)} > limit ${caps.maxConcurrency}`;
  const overStep =
    t.kind === 'playbook' && t.playbook.steps.find((s) => s.maxDurationSec > caps.maxDurationSec);
  if (t.kind === 'preset' && t.preset.maxDurationSec > caps.maxDurationSec)
    return `duration ${t.preset.maxDurationSec}s > limit ${caps.maxDurationSec}s`;
  if (overStep)
    return `a step's duration ${overStep.maxDurationSec}s > limit ${caps.maxDurationSec}s`;
  return null;
}

/** The templates that match an objective, split into single tests and suites. */
export function templatesForObjective(
  o: Objective,
  playbooks: Playbook[],
): { single: Template[]; suite: Template[] } {
  const single: Template[] = o.presetIds
    .map((id) => PRESETS.find((p) => p.id === id))
    .filter((p): p is Preset => !!p)
    .map((preset) => ({ kind: 'preset', id: preset.id, preset }));

  const byId = o.playbookIds
    ? o.playbookIds
        .map((id) => playbooks.find((p) => p.id === id))
        .filter((p): p is Playbook => !!p)
    : [];
  const byCat = o.playbookCategory
    ? playbooks.filter((p) => p.category === o.playbookCategory)
    : [];
  // De-dup while preserving order (explicit ids first, then category matches).
  const seen = new Set<string>();
  const suite: Template[] = [...byId, ...byCat]
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
    .map((playbook) => ({ kind: 'playbook', id: playbook.id, playbook }));

  return { single, suite };
}

export interface RecoContext {
  engines: { id: string; available: boolean }[];
  caps: HardCaps;
  /** The target's most recent WRS point + regression flag, when known. */
  lastWrs?: { wrs: number; level: string; regression: boolean } | null;
}

/** The latest WRS point for a target from the history series (or null). */
export function lastWrsFor(
  target: string,
  series: WrsSeries[],
): { wrs: number; level: string; regression: boolean } | null {
  // Match on hostname so a full URL and the stored host both resolve.
  let host = target;
  try {
    host = new URL(target).hostname;
  } catch {
    /* keep raw */
  }
  const s = series.find((x) => x.target === host || x.target === target);
  const p = s?.points[s.points.length - 1];
  return p ? { wrs: p.wrs, level: p.level, regression: !!s?.regression } : null;
}

function engineOk(t: Template, engines: RecoContext['engines']): boolean {
  const id = templateEngine(t);
  if (!id) return true; // no preference → server default, always fine
  const e = engines.find((x) => x.id === id);
  return e ? e.available : true; // unknown engine → don't penalise
}

/**
 * Pick the best template for an objective given what's runnable now. Returns the
 * choice and a short, human reason ("why this one"). Never returns a template
 * that breaches the effective caps; prefers an installed engine; and reads the
 * target's history to step up, step down, or re-baseline.
 */
export function recommendTemplate(
  o: Objective,
  templates: { single: Template[]; suite: Template[] },
  ctx: RecoContext,
): { pick: Template | null; reason: string } {
  const pool = (
    o.defaultMode === 'suite'
      ? [...templates.suite, ...templates.single]
      : [...templates.single, ...templates.suite]
  ).filter((t) => withinCaps(t, ctx.caps));
  if (pool.length === 0) return { pick: null, reason: 'No template fits the current limits.' };

  const runnable = pool.filter((t) => engineOk(t, ctx.engines));
  const usable = runnable.length ? runnable : pool;

  const gentlest = [...usable].sort((a, b) => peakRps(a) - peakRps(b))[0];
  const hardest = [...usable].sort((a, b) => peakRps(b) - peakRps(a))[0];
  const last = ctx.lastWrs;

  if (!last) {
    return {
      pick: gentlest,
      reason: 'First run on this target — starting gentle to confirm it is testable.',
    };
  }
  if (last.regression) {
    // Re-run a baseline-style single test to compare against the drop.
    const baseline =
      usable.find((t) => t.kind === 'preset' && t.preset.id === 'baseline') ?? gentlest;
    return {
      pick: baseline,
      reason: `A regression was detected here (last WRS ${last.wrs}) — re-run a baseline to compare.`,
    };
  }
  if (last.wrs < 55) {
    return {
      pick: gentlest,
      reason: `The last run struggled (WRS ${last.wrs}) — re-check with a lighter load first.`,
    };
  }
  if (last.wrs >= 85) {
    return {
      pick: hardest,
      reason: `The target held up well last time (WRS ${last.wrs}) — step up to a tougher scenario.`,
    };
  }
  // Middle band: go with the objective's default lead.
  const lead =
    usable.find((t) => (o.defaultMode === 'suite' ? t.kind === 'playbook' : t.kind === 'preset')) ??
    usable[0];
  return { pick: lead, reason: `Solid last score (WRS ${last.wrs}) — a balanced next step.` };
}
