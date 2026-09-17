import type { ReconReport } from './recon.js';
import { reconPostureSnapshot } from './recon.js';
import type {
  Playbook,
  PlaybookStep,
  EngineAvailability,
  ReconSurface,
} from '../playbooks/playbooks.js';
import { stepToCampaignSeed, isBaselineStep } from '../playbooks/playbooks.js';
import type { CampaignInput, TargetRequirement, ReconPostureSnapshot } from '../campaigns/model.js';
import { missingRequirements } from '../campaigns/model.js';
import type { HardCaps } from '../../config/limits.js';

/**
 * P7 — recon-driven action recommender (Phase 1, backend only, read-only).
 *
 * Turns a `ReconReport` into a RANKED set of unitary, fully-seeded, caps-clamped
 * candidate "actions" — one bounded line each (a `CampaignInput` seed with no
 * suite linkage) — so an operator can pick, tune and compose them into a governed
 * campaign/suite. Pure: no network, no side effects, creates nothing. Governance
 * (POST /api/campaigns, composeSuite) remains the only path that ever runs load.
 *
 * A template's `requires` is checked against the recon posture (`reconPostureSnapshot`,
 * the single source of that mapping): a line whose required feature the target
 * lacks is kept but marked N/A (a benign result there is not resistance) and sinks
 * below every applicable line.
 */
export interface SuggestedAction {
  /** Stable id — the source template id, or 'baseline'. */
  id: string;
  title: string;
  summary: string;
  /** Human "why recon suggests this", built from the matched posture signals. */
  rationale: string[];
  category?: string;
  drs?: number;
  requires?: TargetRequirement[];
  /** true when the target exhibits every required feature. */
  applicable: boolean;
  /** The required features the target lacks (present only when not applicable). */
  naReasons?: TargetRequirement[];
  /** Ranking score, descending. */
  relevance: number;
  sourceTemplateId?: string;
  /** Fully recon-seeded, tunable, caps-clamped campaign seed (no suiteId). */
  seed: CampaignInput;
}

export interface RecommendOptions {
  catalogue: Playbook[];
  engines: EngineAvailability[];
  caps: HardCaps;
  target: string;
  probeUrl: string;
  createdBy?: string;
  /** Max actions returned besides the always-included baseline (default 8). */
  topN?: number;
}

/** How much a satisfied requirement matching the target's posture boosts rank. */
const REQUIREMENT_BOOST: Record<TargetRequirement, number> = {
  dynamic: 40,
  waf: 40,
  cache: 30,
  h2: 30,
};
const REQUIREMENT_LABEL: Record<TargetRequirement, string> = {
  h2: 'HTTP/2 endpoint',
  waf: 'WAF / bot-management',
  cache: 'edge cache',
  dynamic: 'dynamic (uncacheable) endpoint',
};
const APPLICABLE_TIER = 1000;

/** Highest-rate non-baseline step — the peak line that characterises a template. */
function peakStep(pb: Playbook): PlaybookStep | undefined {
  if (pb.steps.length === 0) return undefined;
  const attack = pb.steps.filter((s) => !isBaselineStep(s));
  const pool = attack.length ? attack : pb.steps;
  return pool.reduce((a, b) => (b.maxRps > a.maxRps ? b : a));
}

/** Why this line applies (or is N/A) here, from the matched posture signals. */
function buildRationale(
  pb: Playbook,
  posture: ReconPostureSnapshot,
  naReasons: TargetRequirement[],
  recon: ReconReport,
): string[] {
  const out: string[] = [];
  const requires = pb.requires ?? [];
  for (const r of requires) {
    if (!posture[r]) continue;
    if (r === 'dynamic') {
      const p = recon.dynamicPaths?.[0];
      out.push(
        p
          ? `Costliest dynamic path ${p} is origin-served — concentrate fire there.`
          : `Target exposes dynamic (origin-served) paths.`,
      );
    } else if (r === 'waf') {
      out.push(
        `WAF / bot-management detected${recon.profile.vendor ? ` (${recon.profile.vendor})` : ''} — this line measures graceful degradation.`,
      );
    } else if (r === 'cache') {
      out.push(
        `Edge cache present (cache ${recon.profile.cache}${recon.profile.posture.cdn ? ', CDN' : ''}) — a cache-bypass line reaches the origin.`,
      );
    } else if (r === 'h2') {
      out.push(`HTTP/2 negotiated — multiplexing / header-pressure applies.`);
    }
  }
  for (const r of naReasons) {
    out.push(
      `Target has no ${REQUIREMENT_LABEL[r]} — this line is N/A here (a benign result is not resistance).`,
    );
  }
  if (out.length === 0) out.push('Applies to any HTTP target.');
  return out;
}

/** Signature to collapse near-identical / duplicate lines. */
function dedupeSignature(seed: CampaignInput): string {
  const urls = (seed.endpoints ?? [])
    .map((e) => e.url)
    .sort()
    .join(',');
  return [
    seed.vector,
    Math.round(seed.maxRps / 50),
    urls,
    seed.cacheBust ? 'cb' : '',
    seed.noKeepAlive ? 'nka' : '',
  ].join('|');
}

/**
 * Ranked candidate actions for a target, most-relevant first. Always includes a
 * synthesized baseline. Every other action is one template's peak line, seeded
 * from the recon surface and clamped to the effective caps.
 */
export function recommendActions(recon: ReconReport, opts: RecommendOptions): SuggestedAction[] {
  const posture = reconPostureSnapshot(recon);
  const surface: ReconSurface = {
    paths: recon.suggestedPaths ?? [],
    dynamicPaths: recon.dynamicPaths ?? [],
    loginPath: recon.loginPath,
  };
  const createdBy = opts.createdBy ?? 'recommender';

  // Synthesized baseline — a light root health check, always applicable. Built
  // directly (not via stepToCampaignSeed) so it never gets pulled onto a dynamic
  // path by the flood-concentration heuristic.
  const baseline: SuggestedAction = {
    id: 'baseline',
    title: 'Baseline — pre-load health',
    summary: "Pre-load health check: the target's nominal availability + latency, at a light rate.",
    rationale: ['Establishes the pre-load baseline every graded run compares against.'],
    category: 'Baseline',
    requires: [],
    applicable: true,
    relevance: APPLICABLE_TIER,
    seed: {
      name: 'Baseline — pre-load health',
      description: "Pre-load health check on the target's root.",
      target: opts.target,
      vector: 'http-get',
      maxRps: Math.min(20, opts.caps.maxRps),
      concurrency: Math.min(10, opts.caps.maxConcurrency),
      maxDurationSec: Math.min(30, opts.caps.maxDurationSec),
      probeUrl: opts.probeUrl,
      createdBy,
      authorized: true,
      requires: [],
      reconPosture: posture,
    },
  };

  const candidates: SuggestedAction[] = [];
  for (const pb of opts.catalogue) {
    const step = peakStep(pb);
    if (!step) continue;
    const requires = pb.requires;
    const naReasons = missingRequirements(requires, posture);
    const applicable = naReasons.length === 0;
    const seed = stepToCampaignSeed(step, {
      name: pb.name,
      target: opts.target,
      probeUrl: opts.probeUrl,
      createdBy,
      recon: surface,
      reconPosture: posture,
      engines: opts.engines,
      requires,
      caps: opts.caps,
    });
    // Applicable lines always outrank N/A ones; a satisfied requirement matching
    // the posture boosts it; a generic (no-requires) line gets a small nudge;
    // DRS breaks ties.
    let relevance = applicable ? APPLICABLE_TIER : 0;
    if (requires && requires.length) {
      for (const r of requires) if (posture[r]) relevance += REQUIREMENT_BOOST[r];
    } else {
      relevance += 10;
    }
    relevance += pb.drsLevel ?? 0;
    candidates.push({
      id: pb.id,
      title: pb.name,
      summary: pb.summary,
      rationale: buildRationale(pb, posture, naReasons, recon),
      category: pb.category,
      drs: pb.drsLevel,
      requires,
      applicable,
      naReasons: naReasons.length ? naReasons : undefined,
      relevance,
      sourceTemplateId: pb.id,
      seed,
    });
  }

  // Dedupe near-identical lines, keeping the higher-relevance one.
  const bySig = new Map<string, SuggestedAction>();
  for (const a of candidates) {
    const sig = dedupeSignature(a.seed);
    const prev = bySig.get(sig);
    if (!prev || a.relevance > prev.relevance) bySig.set(sig, a);
  }
  const byRelevance = (a: SuggestedAction, b: SuggestedAction): number =>
    b.relevance - a.relevance || a.title.localeCompare(b.title);
  const ranked = [...bySig.values()].sort(byRelevance);

  // Top-N with category diversity (round-robin across category buckets, each in
  // relevance order), then force-include the baseline.
  const cap = opts.topN ?? 8;
  const buckets = new Map<string, SuggestedAction[]>();
  for (const a of ranked) {
    const key = a.category ?? 'Other';
    const bucket = buckets.get(key) ?? [];
    bucket.push(a);
    buckets.set(key, bucket);
  }
  const bucketList = [...buckets.values()];
  const picked: SuggestedAction[] = [];
  let i = 0;
  while (picked.length < cap && bucketList.some((b) => b.length > 0)) {
    const bucket = bucketList[i % bucketList.length];
    if (bucket.length > 0) picked.push(bucket.shift()!);
    i++;
  }

  return [baseline, ...picked].sort(byRelevance);
}
