// Network-bench (class-C) governed dispatch — the control-plane side.
//
// BOUNDARY. UDP amplification is **class C** ("network bench"). The control
// plane NEVER emits or executes it (drs-validation-policy.md). This module only
// lets a CISO **record an authorized run request** and lets an **isolated
// external runner** (the shieldtest-lab) claim that request, execute it outside
// the control plane, and post back a read-only class-C verdict. No amplification
// code lives here; nothing here opens a raw or amplification socket.

/** A governed bench-run request. The control plane records it; a runner fulfils it. */
export type BenchRunStatus = 'REQUESTED' | 'CLAIMED' | 'COMPLETED' | 'FAILED';

export interface BenchVerdict {
  schema: string;
  class: 'C';
  kind?: string;
  scenario?: string;
  labTarget?: string;
  profiles?: string[];
  amplificationFactor?: number;
  packetAmplification?: number;
  requests?: number;
  target?: { packets?: number; avgPps?: number; avgBps?: number };
  mitigation?: {
    strategy?: string;
    engaged?: boolean;
    detectionSec?: number | null;
    dropped?: number;
    collateralPct?: number;
  } | null;
  outcome?: string;
  runner?: string;
  source?: string;
  generatedAt?: string;
}

export interface BenchRun {
  id: string;
  scenario: string;
  labTarget: string;
  status: BenchRunStatus;
  requestedBy: string;
  requestedAt: string; // ISO
  claimedAt?: string;
  claimedBy?: string; // runner identifier
  completedAt?: string;
  verdict?: BenchVerdict;
  error?: string;
}

/**
 * Allowlist of scenarios a CISO may request. Mirrors the lab's scenarios.mjs;
 * the control plane validates against these names — a request naming anything
 * else is rejected. Kept in sync with the lab by review (documented in
 * drs-validation-policy.md).
 */
export const BENCH_SCENARIOS: { name: string; summary: string; useScrubber: boolean }[] = [
  {
    name: 'amplification-ramp',
    summary: 'Byte+packet amplification ramping up.',
    useScrubber: false,
  },
  {
    name: 'packet-rate-stress',
    summary: 'High packet amplification at a steady rate.',
    useScrubber: false,
  },
  {
    name: 'mitigation-delay-study',
    summary: 'Attack through the scrubber; detection delay + residual load.',
    useScrubber: true,
  },
  {
    name: 'collateral-study',
    summary: 'Attack + benign traffic; measure collateral drops.',
    useScrubber: true,
  },
  {
    name: 'wave-detection',
    summary: 'Oscillating (wave) attack rate vs detection.',
    useScrubber: true,
  },
  { name: 'burst-detection', summary: 'On/off burst attack vs detection.', useScrubber: true },
  {
    name: 'progressive-rampup',
    summary: 'Slow ramp; find where detection engages.',
    useScrubber: true,
  },
  {
    name: 'multi-profile-mix',
    summary: 'Three synthetic profiles together; per-profile breakdown.',
    useScrubber: false,
  },
  {
    name: 'mixed-flood-with-legit',
    summary: 'Two attack profiles + benign traffic; realistic collateral.',
    useScrubber: true,
  },
  {
    name: 'blocklist-mitigation',
    summary: 'Signature-style blocklist: forward legit, drop attack.',
    useScrubber: true,
  },
  {
    name: 'adaptive-mitigation',
    summary: 'Adaptive ceiling: loosens on collateral, tightens without.',
    useScrubber: true,
  },
];

const BENCH_SCENARIO_NAMES = new Set(BENCH_SCENARIOS.map((s) => s.name));

export function isKnownBenchScenario(name: unknown): name is string {
  return typeof name === 'string' && BENCH_SCENARIO_NAMES.has(name);
}

/**
 * Validates a verdict posted back by a runner. It must be a class-C artifact
 * for the expected scenario. Returns a sanitised BenchVerdict or throws. The
 * runner is authenticated, but its payload is still untrusted input.
 */
export function parseBenchVerdict(input: unknown, expectedScenario: string): BenchVerdict {
  if (!input || typeof input !== 'object') throw new Error('verdict must be an object');
  const v = input as Record<string, unknown>;
  if (v.class !== 'C') throw new Error('verdict.class must be "C" (network bench)');
  if (typeof v.schema !== 'string' || !v.schema.startsWith('shieldtest.lab.verdict')) {
    throw new Error('verdict.schema must be a shieldtest.lab.verdict artifact');
  }
  if (v.scenario !== undefined && v.scenario !== expectedScenario) {
    throw new Error('verdict.scenario does not match the requested scenario');
  }
  const num = (x: unknown): number | undefined =>
    typeof x === 'number' && Number.isFinite(x) ? x : undefined;
  const t = (v.target ?? {}) as Record<string, unknown>;
  const m = (v.mitigation ?? null) as Record<string, unknown> | null;
  return {
    schema: v.schema,
    class: 'C',
    kind: typeof v.kind === 'string' ? v.kind : undefined,
    scenario: expectedScenario,
    labTarget: typeof v.labTarget === 'string' ? v.labTarget : undefined,
    profiles: Array.isArray(v.profiles)
      ? v.profiles.filter((p) => typeof p === 'string')
      : undefined,
    amplificationFactor: num(v.amplificationFactor),
    packetAmplification: num(v.packetAmplification),
    requests: num(v.requests),
    target: { packets: num(t.packets), avgPps: num(t.avgPps), avgBps: num(t.avgBps) },
    mitigation: m
      ? {
          strategy: typeof m.strategy === 'string' ? m.strategy : undefined,
          engaged: typeof m.engaged === 'boolean' ? m.engaged : undefined,
          detectionSec: num(m.detectionSec) ?? null,
          dropped: num(m.dropped),
          collateralPct: num(m.collateralPct),
        }
      : null,
    outcome: typeof v.outcome === 'string' ? v.outcome : undefined,
    runner: typeof v.runner === 'string' ? v.runner : undefined,
    source: typeof v.source === 'string' ? v.source : undefined,
    generatedAt: typeof v.generatedAt === 'string' ? v.generatedAt : new Date().toISOString(),
  };
}
