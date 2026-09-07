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
 * zeroBS DRS **Volumetric** matrix (report P25-20300), reproduced as the bench
 * catalogue so the CISO sees a 1:1 mapping with the stress-test report. Each
 * vector carries its DRS level and whether this bench can faithfully realize it:
 *
 *   - `reproducible: true`  → a bounded, synthetic realization exists; the id
 *     matches a lab scenario (scenarios.mjs) and may be dispatched.
 *   - `reproducible: false` → out of this bench's model. UDP amplification/rate
 *     vectors are in scope; TCP/GRE stateful floods, IP spoofing and packet
 *     fragmentation are NOT — spoofing is never permitted here by construction,
 *     and the rest are the network team's real bench. These are shown for
 *     coverage but can never be dispatched (fail-closed).
 *
 * The report's Layer-7 vectors (get_flood, post_flood, slowloris, waf_cracker,
 * http2…) are bounded-HTTP and live in the control plane's playbooks, not this
 * class-C bench (see docs/assessment-methodology.md).
 */
export interface BenchScenario {
  id: string;
  title: string;
  proto: 'UDP' | 'TCP' | 'IP' | 'Multi' | 'GRE';
  drs: number;
  reproducible: boolean;
  note: string;
}

export const BENCH_SCENARIOS: BenchScenario[] = [
  {
    id: 'udp_dns_reflection',
    title: 'UDP DNS Reflection',
    proto: 'UDP',
    drs: 3,
    reproducible: true,
    note: 'Synthetic DNS-shape amplification (no real resolver, no spoofing).',
  },
  {
    id: 'tcp_synflood',
    title: 'TCP SynFlood',
    proto: 'TCP',
    drs: 3,
    reproducible: false,
    note: 'Stateful, spoofable TCP flood — the network team’s real bench only.',
  },
  {
    id: 'udp_maxpackets',
    title: 'UDP MaxPackets',
    proto: 'UDP',
    drs: 3,
    reproducible: true,
    note: 'High bounded packet rate; stresses the PPS path.',
  },
  {
    id: 'tcp_maxpackets',
    title: 'TCP MaxPackets',
    proto: 'TCP',
    drs: 3,
    reproducible: false,
    note: 'TCP packet flood — not a UDP amplification shape.',
  },
  {
    id: 'ip_spoofing',
    title: 'IP Spoofing',
    proto: 'IP',
    drs: 4,
    reproducible: false,
    note: 'Source-IP spoofing is NEVER permitted here — the defining safety property of this bench.',
  },
  {
    id: 'udp_fragmentation',
    title: 'UDP Fragmentation',
    proto: 'UDP',
    drs: 4,
    reproducible: false,
    note: 'Fragment crafting — outside the synthetic model (no raw packet crafting).',
  },
  {
    id: 'tcp_fragmentation',
    title: 'TCP Fragmentation',
    proto: 'TCP',
    drs: 4,
    reproducible: false,
    note: 'TCP + fragment crafting — out of model.',
  },
  {
    id: 'udp_multivector',
    title: 'UDP MultiVector',
    proto: 'UDP',
    drs: 4,
    reproducible: true,
    note: 'Several synthetic UDP amplification profiles fired together.',
  },
  {
    id: 'tcp_multivector',
    title: 'TCP MultiVector',
    proto: 'TCP',
    drs: 4,
    reproducible: false,
    note: 'TCP multi-vector — out of model.',
  },
  {
    id: 'multiproto_multivector',
    title: 'Multi-proto MultiVector',
    proto: 'Multi',
    drs: 5,
    reproducible: false,
    note: 'UDP+TCP+GRE mix — includes non-UDP, out-of-model vectors.',
  },
  {
    id: 'gre_packets',
    title: 'GRE Packets',
    proto: 'GRE',
    drs: 5,
    reproducible: false,
    note: 'GRE protocol packets — not a UDP amplification shape.',
  },
];

const DISPATCHABLE = new Set(BENCH_SCENARIOS.filter((s) => s.reproducible).map((s) => s.id));

/** A scenario id the control plane will accept for dispatch (reproducible only). */
export function isKnownBenchScenario(name: unknown): name is string {
  return typeof name === 'string' && DISPATCHABLE.has(name);
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

// --- Coverage methods ------------------------------------------------------
//
// A vector can be *covered* without this bench emitting anything. Each coverage
// method carries a different assurance level, honestly labelled so the CISO sees
// HOW each vector is covered — turning the out-of-model vectors from "no data"
// into qualified coverage. None of these methods emit spoofed or raw flood
// traffic; that remains permanently refused.
//
//   MEASURED_LAB      — a bounded, synthetic run in the isolated lab (the only
//                       method that produces a class-C verdict via a bench run).
//   INGESTED_EXTERNAL — a read-only verdict transcribed from the network team's
//                       real L3/4 bench (out-of-model vectors they own).
//   ATTESTED          — evidence of a control (e.g. BCP38/uRPF for ip_spoofing,
//                       GRE-drop for gre_packets) — verification, not simulation.
//   MODELLED          — an estimated resilience judgement with rationale; no
//                       traffic at all. Clearly non-measured.
//   REPLAY            — a sanitized PCAP replayed in the isolated lab (spoofed
//                       sources rewritten to lab addresses) for detection testing.
export const COVERAGE_METHODS = [
  'MEASURED_LAB',
  'INGESTED_EXTERNAL',
  'ATTESTED',
  'MODELLED',
  'REPLAY',
] as const;
export type CoverageMethod = (typeof COVERAGE_METHODS)[number];

// Methods a CISO may record by hand (evidence-based). MEASURED_LAB is never
// hand-recorded — it can only come from an actual bench run's verdict.
export const RECORDABLE_METHODS: CoverageMethod[] = [
  'INGESTED_EXTERNAL',
  'ATTESTED',
  'MODELLED',
  'REPLAY',
];

export interface BenchCoverage {
  id: string;
  vector: string; // a BENCH_SCENARIOS id (may be an out-of-model vector)
  method: CoverageMethod;
  outcome?: string; // e.g. MITIGATED / NOT_MITIGATED / PASS / FAIL — free but bounded
  drs?: number; // DRS level achieved/tested, when applicable
  summary: string; // the evidence / rationale (required)
  source: string; // who/what produced it (e.g. 'network-team-bench', 'edge-config')
  recordedBy: string;
  at: string; // ISO
}

const CATALOGUE_IDS = new Set(BENCH_SCENARIOS.map((s) => s.id));

/** Validates a hand-recorded coverage entry (untrusted request body). */
export function parseCoverageInput(
  input: unknown,
  recordedBy: string,
): Omit<BenchCoverage, 'id' | 'at'> {
  const b = (input ?? {}) as Record<string, unknown>;
  const vector = String(b.vector ?? '').trim();
  if (!CATALOGUE_IDS.has(vector)) throw new Error('vector must be a known bench vector id');
  const method = String(b.method ?? '') as CoverageMethod;
  if (!RECORDABLE_METHODS.includes(method)) {
    throw new Error(`method must be one of ${RECORDABLE_METHODS.join(', ')}`);
  }
  const summary = String(b.summary ?? '').trim();
  if (!summary) throw new Error('summary (evidence/rationale) is required');
  const drs = typeof b.drs === 'number' && Number.isFinite(b.drs) ? b.drs : undefined;
  return {
    vector,
    method,
    outcome: b.outcome ? String(b.outcome).slice(0, 40) : undefined,
    drs,
    summary: summary.slice(0, 2000),
    source: (b.source ? String(b.source) : 'operator').slice(0, 120),
    recordedBy,
  };
}
