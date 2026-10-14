import { htmlEscape as esc } from '../../util/text.js';
import type { PostureReport } from '../posture/analyze.js';
import type { AbsorptionSummaryRow } from '../observability/summary.js';
import {
  BENCH_SCENARIOS,
  CLASS_C_LADDERS,
  benchLadderScenarios,
  type BenchCoverage,
} from '../bench/model.js';
import { getPlaybook, drsLineTemplateId, type LoadProfile } from '../playbooks/playbooks.js';

/**
 * RPT-05 — Protection-gap analyzer, shaped to the real DRS P26-20371 run.
 *
 * Given the DECLARED WEDOS controls for the authorized target, model the
 * engagement the way DRS actually drives it and emit the plan that follows
 * from it:
 *   - each threat line is mitigated by a CHAIN of controls; the attacker works
 *     the weakest link, so coverage is the worst control in the chain;
 *   - lines are laid out as a DRS escalation ladder (3 → 4 → 5), because the
 *     playbook climbs attacker capability and a collapsed lower tier makes the
 *     higher tiers moot;
 *   - the earliest tier with a real gap is the predicted BREAK POINT — where
 *     DRS would stop climbing and concentrate;
 *   - every line carries the real, capped intensity of its bounded playbook step
 *     (rps / concurrency / duration / shape) so the plan reads like the scenario.
 *
 * It stays strictly inside the bounded model: it SELECTS and ORDERS existing
 * bounded vectors and synthesises none. No evasion payloads, no cap or allowlist
 * change, no traffic. Knowing the defense only decides where to point the same
 * governed test first — never how to defeat a rule. The HPACK bomb, WAF-cracker,
 * credential brute-force and L3/4 handshake lines stay attestation-only.
 */

/** A defensive control class that can mitigate one or more threat lines. */
export type ControlKey =
  | 'synFloodProtection'
  | 'slowRequestTimeout'
  | 'rateLimiting'
  | 'originShielding'
  | 'cacheKeyPolicy'
  | 'urlAllowlist'
  | 'methodPolicy'
  | 'http2Guard'
  | 'challenge'
  | 'wafSignatures'
  | 'bruteForceProtection';

export const CONTROL_LABELS: Record<ControlKey, string> = {
  synFloodProtection: 'SYN-flood / handshake protection (L3/4)',
  slowRequestTimeout: 'Slow-request / header timeout',
  rateLimiting: 'Request rate limiting',
  originShielding: 'Origin shielding / edge 404',
  cacheKeyPolicy: 'Cache-key policy',
  urlAllowlist: 'URL / path allowlist',
  methodPolicy: 'HTTP method policy',
  http2Guard: 'HTTP/2 abuse guard (rapid-reset / continuation)',
  challenge: 'Bot challenge (JS / PoW / CAPTCHA)',
  wafSignatures: 'WAF signature ruleset',
  bruteForceProtection: 'Credential brute-force protection',
};

/** How a control is declared: proven present, partial, absent, or not declared. */
export type ControlStatus = 'present' | 'partial' | 'absent' | 'unknown';

/** Declared WEDOS control profile for the target (missing keys → 'unknown'). */
export type ProtectionProfile = Partial<Record<ControlKey, ControlStatus>>;

/** Whether a threat line can be exercised by a bounded vector or stays attested. */
type Disposition = 'bounded' | 'attested';

interface ThreatLine {
  line: number;
  drs: number;
  name: string;
  /** The chain of controls that mitigate this line; the weakest link decides. */
  controls: ControlKey[];
  disposition: Disposition;
  /** Bounded lines: the pretest-cra-l7 step that exercises this line. */
  step?: string;
  /** DRS5 lines that chain the earlier primitives (DRS runs them last). */
  combination?: boolean;
  /** Attested lines / partials: why part of it is out of the bounded model. */
  attestedNote?: string;
}

/**
 * The P26-20371 matrix in engagement order, keyed to the control CHAIN that
 * mitigates each line and its disposition.
 */
const THREAT_LINES: ThreatLine[] = [
  {
    line: 1,
    drs: 3,
    name: 'TCP-Handshakes',
    controls: ['synFloodProtection'],
    disposition: 'attested',
    attestedNote:
      'L3/4 state-table line — runs on the isolated class-C bench, not the L7 playbook.',
  },
  {
    line: 2,
    drs: 3,
    name: 'SlowLoris',
    controls: ['slowRequestTimeout'],
    disposition: 'bounded',
    step: 'SlowLoris (DRS3)',
  },
  {
    line: 3,
    drs: 3,
    name: 'HTTP GET-Flood',
    controls: ['rateLimiting'],
    disposition: 'bounded',
    step: 'GET-Flood (DRS3)',
  },
  {
    line: 4,
    drs: 3,
    name: 'GET-Random-Flood',
    controls: ['originShielding', 'rateLimiting'],
    disposition: 'bounded',
    step: 'GET-Random-Flood (DRS3)',
  },
  {
    line: 5,
    drs: 4,
    name: 'GET /VALID_RANDOM',
    controls: ['cacheKeyPolicy', 'rateLimiting'],
    disposition: 'bounded',
    step: 'GET /VALID_RANDOM (DRS4)',
  },
  {
    line: 6,
    drs: 4,
    name: 'HTTP POST-Flood',
    controls: ['methodPolicy', 'rateLimiting'],
    disposition: 'bounded',
    step: 'POST-Flood (DRS4)',
  },
  {
    line: 7,
    drs: 4,
    name: 'HTTP/2 GET-Flood',
    controls: ['http2Guard', 'rateLimiting'],
    disposition: 'bounded',
    step: 'HTTP/2 GET-Flood (DRS4)',
  },
  {
    line: 8,
    drs: 4,
    name: 'HTTP/2 Rapid Reset / Continuation',
    controls: ['http2Guard'],
    disposition: 'bounded',
    step: 'HTTP/2 Continuation — header pressure (DRS4)',
    attestedNote:
      'Rapid-reset and continuation are exercised bounded; the HPACK decompression bomb stays attested (amplification exploit, not emitted).',
  },
  {
    line: 9,
    drs: 5,
    name: 'POST-Flood (login/account)',
    controls: ['challenge', 'rateLimiting', 'bruteForceProtection'],
    disposition: 'bounded',
    step: 'Login/account POST-Flood (DRS5)',
  },
  {
    line: 10,
    drs: 5,
    name: 'HTTP MultiVector',
    controls: ['rateLimiting', 'challenge', 'http2Guard'],
    disposition: 'bounded',
    step: 'L7 MultiVector (DRS5)',
    combination: true,
  },
  {
    line: 11,
    drs: 5,
    name: 'Layer-7-THOR / PulseWave',
    controls: ['challenge', 'rateLimiting'],
    disposition: 'bounded',
    step: 'THOR / PulseWave — synchronized (DRS5)',
    combination: true,
  },
  {
    line: 12,
    drs: 5,
    name: 'WAF-Cracker',
    controls: ['wafSignatures'],
    disposition: 'attested',
    attestedNote:
      'Live SQLi/XSS/RCE payloads — weaponized, never emitted; WAF efficacy is attested from the ruleset.',
  },
  {
    line: 13,
    drs: 5,
    name: 'MultiTarget / carpet-bombing',
    controls: ['challenge', 'rateLimiting', 'originShielding'],
    disposition: 'bounded',
    step: 'MultiTarget / carpet-bombing (DRS5)',
    combination: true,
  },
  {
    line: 14,
    drs: 4,
    name: 'RANDOM POST / LOGIN_BRUTE_FORCE',
    controls: ['bruteForceProtection'],
    disposition: 'attested',
    attestedNote:
      'Bounded POST is covered (line 6/9); credential brute-force stays out of the model by design.',
  },
];

/** Ordered worst→best so the chain's weakest link is the max weight. */
const STATUS_WEIGHT: Record<ControlStatus, number> = {
  absent: 3,
  unknown: 2,
  partial: 1,
  present: 0,
};

export type Priority = 'high' | 'medium' | 'low';

function priorityOf(score: number): Priority {
  if (score >= 7) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

/** DRS attacker-capability tier label for a DRS level. */
export function drsTier(drs: number): string {
  if (drs >= 5) return 'DRS 5 — advanced / nation-state';
  if (drs === 4) return 'DRS 4 — elevated / botnet';
  return 'DRS 3 — commodity capability';
}

export interface ControlState {
  key: ControlKey;
  label: string;
  status: ControlStatus;
}

/** Real, capped intensity of the bounded playbook step for a line. */
export interface Intensity {
  maxRps: number;
  concurrency: number;
  durationSec: number;
  profile: LoadProfile;
}

export interface PlanItem {
  line: number;
  drs: number;
  tier: string;
  name: string;
  /** Full control chain with each link's declared status. */
  controls: ControlState[];
  /** The weakest link — the one DRS would work. */
  weakest: ControlState;
  priority: Priority;
  score: number;
  step: string;
  /** The replayable single-step template for this line, when one exists — lets
   *  the planner compose the recommended lines straight into a campaign. */
  templateId?: string;
  intensity?: Intensity;
  combination: boolean;
  rationale: string;
  attestedNote?: string;
}

export interface AttestationItem {
  line: number;
  drs: number;
  tier: string;
  name: string;
  controls: ControlState[];
  note: string;
}

export interface GapAnalysis {
  generatedAt: string;
  target?: string;
  /** Bounded lines as a DRS escalation ladder (3 → 4 → 5), the engagement order. */
  plan: PlanItem[];
  /** Out-of-model lines: verify by attestation, never emitted. */
  attestationOnly: AttestationItem[];
  /** The earliest line in the ladder with a real gap — where DRS concentrates. */
  breakPoint: {
    line: number;
    name: string;
    drs: number;
    weakest: ControlState;
    note: string;
  } | null;
  summary: { high: number; medium: number; low: number; attested: number };
}

function statesOf(controls: ControlKey[], profile: ProtectionProfile): ControlState[] {
  return controls.map((key) => ({
    key,
    label: CONTROL_LABELS[key],
    status: profile[key] ?? 'unknown',
  }));
}

/** The weakest link in a chain — the control with the highest status weight. */
function weakestOf(states: ControlState[]): ControlState {
  return states.reduce((worst, s) =>
    STATUS_WEIGHT[s.status] > STATUS_WEIGHT[worst.status] ? s : worst,
  );
}

// Intensities come from the real pretest-cra-l7 steps (single source of truth).
const STEP_INTENSITY: Map<string, Intensity> = (() => {
  const m = new Map<string, Intensity>();
  const pb = getPlaybook('pretest-cra-l7');
  for (const s of pb?.steps ?? []) {
    m.set(s.name, {
      maxRps: s.maxRps,
      concurrency: s.concurrency,
      durationSec: s.maxDurationSec,
      profile: s.profile,
    });
  }
  return m;
})();

/**
 * Maps a declared control profile to a DRS-shaped escalation plan: bounded
 * lines in DRS order with per-line weakest-link coverage and real capped
 * intensity, a predicted break point, and the attestation-only lines.
 */
export function analyzeGaps(profile: ProtectionProfile, target?: string): GapAnalysis {
  const plan: PlanItem[] = [];
  const attestationOnly: AttestationItem[] = [];

  for (const t of THREAT_LINES) {
    const controls = statesOf(t.controls, profile);
    const tier = drsTier(t.drs);
    if (t.disposition === 'bounded') {
      const weakest = weakestOf(controls);
      const score = t.drs + STATUS_WEIGHT[weakest.status];
      const priority = priorityOf(score);
      const w = weakest.label.toLowerCase();
      const rationale =
        weakest.status === 'absent'
          ? `Weakest link: no ${w} declared — replay to see if the edge holds without it.`
          : weakest.status === 'partial'
            ? `Weakest link: ${w} is partial — replay to find where it stops holding.`
            : weakest.status === 'unknown'
              ? `Weakest link: ${w} not declared — replay to establish the baseline.`
              : `Chain fully declared — replay to confirm and measure collateral.`;
      plan.push({
        line: t.line,
        drs: t.drs,
        tier,
        name: t.name,
        controls,
        weakest,
        priority,
        score,
        step: t.step!,
        templateId: getPlaybook(drsLineTemplateId(t.step!))
          ? drsLineTemplateId(t.step!)
          : undefined,
        intensity: STEP_INTENSITY.get(t.step!),
        combination: t.combination ?? false,
        rationale,
        attestedNote: t.attestedNote,
      });
    } else {
      attestationOnly.push({
        line: t.line,
        drs: t.drs,
        tier,
        name: t.name,
        controls,
        note: t.attestedNote ?? 'Out of the bounded model by design.',
      });
    }
  }

  // Engagement order: climb the DRS ladder (low → high), line order within a tier.
  plan.sort((a, b) => a.drs - b.drs || a.line - b.line);

  // Break point: the earliest tier with a real gap is where DRS concentrates.
  const firstAbsent = plan.find((p) => p.weakest.status === 'absent');
  const firstHigh = plan.find((p) => p.priority === 'high');
  const firstUnknown = plan.find((p) => p.weakest.status === 'unknown');
  const bp = firstAbsent ?? firstHigh ?? firstUnknown ?? null;
  const breakPoint = bp
    ? {
        line: bp.line,
        name: bp.name,
        drs: bp.drs,
        weakest: bp.weakest,
        note:
          bp.weakest.status === 'absent'
            ? `No ${bp.weakest.label.toLowerCase()} on a ${drsTier(bp.drs)} line — the ladder likely breaks here; DRS would concentrate and escalate from this rung.`
            : `Weakest rung on the ladder (${bp.weakest.label.toLowerCase()}: ${bp.weakest.status}) — prove this line first, it gates everything above it.`,
      }
    : null;

  const summary = {
    high: plan.filter((p) => p.priority === 'high').length,
    medium: plan.filter((p) => p.priority === 'medium').length,
    low: plan.filter((p) => p.priority === 'low').length,
    attested: attestationOnly.length,
  };
  return {
    generatedAt: new Date().toISOString(),
    target,
    plan,
    attestationOnly,
    breakPoint,
    summary,
  };
}

/**
 * Seeds a profile from the passive posture inference (posture/analyze.ts). Only
 * sets controls the probe positively observed to 'present'; everything else is
 * left 'unknown' — passive inference cannot prove a control is absent.
 */
export function postureToProfile(posture: PostureReport): ProtectionProfile {
  const p: ProtectionProfile = {};
  if (posture.rateLimiting) p.rateLimiting = 'present';
  if (posture.waf) {
    p.wafSignatures = 'present';
    p.methodPolicy = 'present';
  }
  if (posture.cdn) {
    p.originShielding = 'present';
    p.cacheKeyPolicy = 'present';
  }
  return p;
}

/** Where an inferred control status came from — carried so the operator sees the
 *  evidence behind the seeded plan and can override it. */
export type EvidenceSource = 'recon' | 'run' | 'lab';
export interface ControlEvidence {
  status: ControlStatus;
  source: EvidenceSource;
  note: string;
}
export interface InferredProfile {
  profile: ProtectionProfile;
  provenance: Partial<Record<ControlKey, ControlEvidence[]>>;
}

/** Evidence the planner can infer a profile from (all optional, all fail-soft). */
export interface GapEvidence {
  /** Passive recon posture for the target (latest run's inference). */
  posture?: PostureReport;
  /** Per-vector absorption rollup of prior BOUNDED runs against the target. */
  absorption?: AbsorptionSummaryRow[];
  /** Class-C lab (network-bench) coverage/verdicts — the L3/4 evidence the L7
   *  control plane can never observe itself. */
  labCoverage?: BenchCoverage[];
}

const SOURCE_RANK: Record<EvidenceSource, number> = { lab: 3, run: 2, recon: 1 };

// Read the lab's free-but-bounded verdict text into a coarse status.
const LAB_GAP_RE = /not[_ -]?mitigated|fail|breach|through|leak/i;
const LAB_OK_RE = /mitigated|pass|absorb|dropped|blocked|contained/i;

/** One L3/4 network vector on the lab's DRS ladder. */
export type NetworkVectorStatus = 'absorbed' | 'gap' | 'uncovered';
export interface NetworkVector {
  id: string;
  title: string;
  proto: string;
  drs: number;
  status: NetworkVectorStatus;
  outcome?: string;
  source?: string;
  at?: string;
}
export interface NetworkTier {
  drs: number;
  vectors: NetworkVector[];
  verdict: NetworkVectorStatus | 'partial';
}
export interface NetworkLadder {
  tiers: NetworkTier[];
  /** Lowest DRS tier where the lab found a gap — the network weakest link. */
  weakest?: { drs: number; id: string; title: string };
  covered: number;
  total: number;
}

function labStatusOf(c?: BenchCoverage): NetworkVectorStatus {
  if (!c) return 'uncovered';
  if (LAB_GAP_RE.test(c.outcome ?? '')) return 'gap';
  if (LAB_OK_RE.test(c.outcome ?? '')) return 'absorbed';
  return 'absorbed'; // covered with a neutral outcome → the lab has handling evidence
}

/**
 * Turn the class-C lab's per-scenario coverage into a DRS 3→5 NETWORK ladder —
 * the L3/4 half of a full-stack plan that the bounded L7 control plane can't
 * test. Every network vector (BENCH_SCENARIOS) is placed on its DRS tier and
 * overlaid with the lab's latest verdict (absorbed / gap / no lab evidence); the
 * weakest link is the lowest tier the lab found a gap at, mirroring the L7 model.
 */
export function buildNetworkLadder(coverage: BenchCoverage[]): NetworkLadder {
  const latest = new Map<string, BenchCoverage>();
  for (const c of coverage) {
    const prev = latest.get(c.vector);
    if (!prev || c.at > prev.at) latest.set(c.vector, c);
  }
  const drsLevels = [...new Set(BENCH_SCENARIOS.map((s) => s.drs))].sort((a, b) => a - b);
  const tiers: NetworkTier[] = drsLevels.map((drs) => {
    const vectors: NetworkVector[] = BENCH_SCENARIOS.filter((s) => s.drs === drs).map((s) => {
      const c = latest.get(s.id);
      return {
        id: s.id,
        title: s.title,
        proto: s.proto,
        drs,
        status: labStatusOf(c),
        outcome: c?.outcome,
        source: c?.source,
        at: c?.at,
      };
    });
    const hasGap = vectors.some((v) => v.status === 'gap');
    const allUncovered = vectors.every((v) => v.status === 'uncovered');
    const someUncovered = vectors.some((v) => v.status === 'uncovered');
    const verdict: NetworkTier['verdict'] = hasGap
      ? 'gap'
      : allUncovered
        ? 'uncovered'
        : someUncovered
          ? 'partial'
          : 'absorbed';
    return { drs, vectors, verdict };
  });
  let weakest: NetworkLadder['weakest'];
  for (const t of tiers) {
    const g = t.vectors.find((v) => v.status === 'gap');
    if (g) {
      weakest = { drs: t.drs, id: g.id, title: g.title };
      break;
    }
  }
  const known = new Set(BENCH_SCENARIOS.map((s) => s.id));
  const covered = [...latest.keys()].filter((id) => known.has(id)).length;
  return { tiers, weakest, covered, total: BENCH_SCENARIOS.length };
}

/**
 * The class-C companion evidence for an L7 playbook: fuse a bench LADDER (the
 * synthetic, no-spoof network scenarios paired with the L7 template) with the
 * lab's recorded coverage, into one cross-layer assurance view. The control
 * plane never executes the ladder — this reads back the isolated lab's read-only
 * verdicts and reports which network vectors are absorbed / gapped / not yet run.
 * Pure.
 */
export interface CrossLayerAssurance {
  ladderId: string;
  ladderTitle: string;
  vectors: NetworkVector[];
  covered: number;
  gaps: number;
  uncovered: number;
  total: number;
  /** Lowest-DRS network gap — the class-C weakest link to run/mitigate first. */
  weakest?: { drs: number; id: string; title: string };
}

export function crossLayerAssurance(
  ladderId: string,
  coverage: BenchCoverage[],
): CrossLayerAssurance {
  const scenarios = benchLadderScenarios(ladderId); // throws on an invalid ladder
  // Latest coverage per vector (most recent `at` wins).
  const latest = new Map<string, BenchCoverage>();
  for (const c of coverage) {
    const prev = latest.get(c.vector);
    if (!prev || Date.parse(c.at) > Date.parse(prev.at)) latest.set(c.vector, c);
  }
  const vectors: NetworkVector[] = scenarios.map((s) => {
    const c = latest.get(s.id);
    return {
      id: s.id,
      title: s.title,
      proto: s.proto,
      drs: s.drs,
      status: labStatusOf(c),
      outcome: c?.outcome,
      source: c?.source,
      at: c?.at,
    };
  });
  const covered = vectors.filter((v) => v.status === 'absorbed').length;
  const gaps = vectors.filter((v) => v.status === 'gap').length;
  const uncovered = vectors.filter((v) => v.status === 'uncovered').length;
  const firstGap = [...vectors].filter((v) => v.status === 'gap').sort((a, b) => a.drs - b.drs)[0];
  const ladder = CLASS_C_LADDERS.find((l) => l.id === ladderId)!;
  return {
    ladderId,
    ladderTitle: ladder.title,
    vectors,
    covered,
    gaps,
    uncovered,
    total: vectors.length,
    weakest: firstGap ? { drs: firstGap.drs, id: firstGap.id, title: firstGap.title } : undefined,
  };
}

/**
 * Infer a ProtectionProfile from evidence instead of a from-scratch manual
 * declaration: recon fills what it observed passively, prior bounded runs fill
 * what their absorption revealed (edge rejects → rate-limiting; tarpit → slow-
 * request handling), and the class-C LAB fills the network controls (SYN/handshake
 * protection) that no L7 test can see. Every control keeps its provenance so the
 * operator reviews rather than trusts blindly; nothing is proven 'absent' from
 * passive signals alone — only the lab's own verdict may mark a control absent.
 */
export function inferProfile(ev: GapEvidence): InferredProfile {
  const provenance: Partial<Record<ControlKey, ControlEvidence[]>> = {};
  const add = (key: ControlKey, status: ControlStatus, source: EvidenceSource, note: string) => {
    (provenance[key] ??= []).push({ status, source, note });
  };

  // 1. Recon (passive) — only ever 'present'; passive signals can't prove absence.
  if (ev.posture) {
    for (const [k, st] of Object.entries(postureToProfile(ev.posture)) as [
      ControlKey,
      ControlStatus,
    ][]) {
      add(k, st, 'recon', 'observed passively during recon');
    }
  }

  // 2. Prior bounded runs — the absorption mechanism split names the control.
  for (const row of ev.absorption ?? []) {
    if (row.lastRejectedPct >= 30) {
      add('rateLimiting', 'present', 'run', `${row.vector}: ${row.lastRejectedPct}% edge-rejected`);
    }
    if (row.lastTarpitPct >= 30) {
      add(
        'slowRequestTimeout',
        'present',
        'run',
        `${row.vector}: ${row.lastTarpitPct}% held/tarpitted`,
      );
    }
  }

  // 3. Class-C lab — the network DRS ladder informs SYN/handshake protection (the
  //    L3/4 control the bounded L7 tests deliberately never exercise). The weakest
  //    link decides, mirroring the L7 model: a gap at the DRS-3 foundation proves
  //    it 'absent'; a gap only at a higher tier is 'partial'; no gap → 'present'.
  //    The lab is the one source allowed to prove this control absent.
  const ladder = buildNetworkLadder(ev.labCoverage ?? []);
  if (ladder.covered > 0) {
    if (ladder.weakest) {
      add(
        'synFloodProtection',
        ladder.weakest.drs <= 3 ? 'absent' : 'partial',
        'lab',
        `lab gap at DRS${ladder.weakest.drs}: ${ladder.weakest.title}`,
      );
    } else {
      add(
        'synFloodProtection',
        'present',
        'lab',
        `lab: ${ladder.covered}/${ladder.total} network vectors absorbed, no gap`,
      );
    }
  }

  // Resolve each control to its strongest-source evidence (lab > run > recon).
  const profile: ProtectionProfile = {};
  for (const [k, evs] of Object.entries(provenance) as [ControlKey, ControlEvidence[]][]) {
    const best = [...evs].sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source])[0];
    profile[k] = best.status;
  }
  return { profile, provenance };
}

const PRIORITY_CLASS: Record<Priority, string> = { high: 'p-high', medium: 'p-med', low: 'p-low' };

function chainHtml(controls: ControlState[], weakestKey: ControlKey): string {
  return controls
    .map(
      (c) =>
        `<span class="ctl${c.key === weakestKey ? ' ctl-weak' : ''}">${esc(c.label)} <span class="muted">(${c.status})</span></span>`,
    )
    .join(' · ');
}

function intensityHtml(i?: Intensity): string {
  if (!i) return '';
  return `<span class="muted">≤ ${i.maxRps} rps · ${i.concurrency} conns · ${i.durationSec}s · ${i.profile}</span>`;
}

/** Renders the gap analysis as a standalone HTML report (print/PDF ready). */
export function renderGapAnalysisHtml(a: GapAnalysis): string {
  // Group the plan into DRS tiers so it reads as the escalation ladder.
  const tiers = [...new Set(a.plan.map((p) => p.drs))].sort((x, y) => x - y);
  const ladder = tiers
    .map((drs) => {
      const rows = a.plan
        .filter((p) => p.drs === drs)
        .map(
          (p) =>
            `<tr${p.line === a.breakPoint?.line ? ' class="breakrow"' : ''}><td>${p.line}</td><td>${esc(
              p.name,
            )}${p.combination ? ' <span class="tag">combo</span>' : ''}${
              p.line === a.breakPoint?.line ? ' <span class="tag tag-break">break point</span>' : ''
            }</td><td>${chainHtml(p.controls, p.weakest.key)}</td><td><span class="pill ${
              PRIORITY_CLASS[p.priority]
            }">${p.priority}</span></td><td>${esc(p.step)}<br>${intensityHtml(
              p.intensity,
            )}<br><span class="muted">${esc(p.rationale)}</span>${
              p.attestedNote ? `<br><span class="muted">⚠ ${esc(p.attestedNote)}</span>` : ''
            }</td></tr>`,
        )
        .join('\n');
      return `<h3>${esc(drsTier(drs))}</h3>
<table><tr><th>#</th><th>Threat line</th><th>Control chain (weakest in bold)</th><th>Priority</th><th>Step · capped intensity · why</th></tr>
${rows}
</table>`;
    })
    .join('\n');

  const attRows = a.attestationOnly
    .map(
      (x) =>
        `<tr><td>${x.line}</td><td>DRS${x.drs}</td><td>${esc(x.name)}</td><td>${chainHtml(
          x.controls,
          x.controls[0]?.key,
        )}</td><td>${esc(x.note)}</td></tr>`,
    )
    .join('\n');

  const breakHtml = a.breakPoint
    ? `<div class="break"><b>Predicted break point — line ${a.breakPoint.line} (${esc(
        a.breakPoint.name,
      )}, ${esc(drsTier(a.breakPoint.drs))}).</b> ${esc(a.breakPoint.note)}</div>`
    : `<div class="break ok"><b>No gap on the ladder from the declared controls.</b> Escalate the full DRS 3→5 sequence to confirm the ceiling, watching collateral on the probe.</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Protection-gap analysis — WEDOS ShieldTest</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:1000px}
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #003484;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0}.wm{font-weight:800;color:#003484}
 h2{color:#003484;margin-top:1.4rem;font-size:1.1rem}
 h3{margin:1rem 0 .25rem;font-size:1rem}
 table{border-collapse:collapse;width:100%;margin:.4rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}
 .muted{color:#666}
 .ctl-weak{font-weight:800;color:#c23b34}
 .pill{display:inline-block;padding:.05rem .5rem;border-radius:999px;font-weight:700;color:#fff;font-size:.85rem}
 .p-high{background:#c23b34}.p-med{background:#b8860b}.p-low{background:#0f8a5f}
 .tag{display:inline-block;padding:0 .4rem;border-radius:4px;background:#eef;border:1px solid #ccd;font-size:.75rem;color:#334}
 .tag-break{background:#fde7e6;border-color:#e0b4b1;color:#8a2a24}
 .breakrow{background:#fdf3f2}
 .break{margin:.8rem 0;padding:.6rem .8rem;border-left:4px solid #c23b34;background:#fdf3f2}
 .break.ok{border-left-color:#0f8a5f;background:#eef9f3}
 .print-btn{position:fixed;top:1rem;right:1rem;background:#003484;color:#fff;border:0;border-radius:6px;padding:.5rem .9rem;font:inherit;font-weight:600;cursor:pointer}
 @media print{.print-btn{display:none}body{margin:0}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / PDF</button>
<div class="brand">
 <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4aa0"/><stop offset="1" stop-color="#003484"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
 <h1><span class="wm">WEDOS ShieldTest</span> — Protection-gap analysis (DRS P26-20371 shape)</h1>
</div>
<p class="muted">Generated on ${esc(a.generatedAt)}${
    a.target ? ` · target <code>${esc(a.target)}</code>` : ''
  } · WEDOS internal use</p>
<p><b>${a.summary.high}</b> high · <b>${a.summary.medium}</b> medium · <b>${a.summary.low}</b> low priority to replay · <b>${a.summary.attested}</b> attestation-only line(s).</p>
${breakHtml}
<h2>DRS escalation ladder (replay in this order)</h2>
<p class="muted">The DRS engagement climbs attacker capability 3 → 4 → 5. Replay each rung, read the per-line delta with the suite-compare, and fix the weakest link before climbing. Intensities are the real capped playbook values.</p>
${ladder}
<h2>Attestation-only (out of the bounded model)</h2>
<p class="muted">Validated by attestation of the control, never emitted — no exploit, amplification or spoofing.</p>
<table><tr><th>#</th><th>DRS</th><th>Threat line</th><th>Control</th><th>Disposition</th></tr>
${attRows}
</table>
<p class="muted">Analytical only — selects and orders existing bounded vectors against the
authorized target from the declared defense; it synthesises no attack, defeats no rule, and relaxes no cap/allowlist.</p>
</body></html>`;
}
