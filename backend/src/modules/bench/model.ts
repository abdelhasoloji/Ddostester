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
  // TCP connection-pressure runs (kind 'tcp-connection-pressure') carry this
  // instead of amplification metrics.
  connections?: {
    opened?: number;
    accepted?: number;
    refused?: number;
    concurrentPeak?: number;
    capacity?: number;
    saturationPct?: number;
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
    reproducible: true,
    note: 'No-spoof connection/state-table pressure (real source, capped) — the flood’s exhaustion shape without spoofing.',
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
    reproducible: true,
    note: 'High bounded TCP connection rate (no-spoof) — connection-table churn.',
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
  // ── Additional SYNTHETIC, NO-SPOOF, bounded shapes (reproducible on the lab) ──
  // Each models the traffic SHAPE of a reflector/flood family — never a real
  // resolver/reflector, never source-IP spoofing, never raw packet crafting.
  {
    id: 'udp_ntp_reflection',
    title: 'UDP NTP Reflection',
    proto: 'UDP',
    drs: 3,
    reproducible: true,
    note: 'Synthetic NTP monlist-shape amplification (no real NTP server, no spoofing).',
  },
  {
    id: 'udp_ssdp_reflection',
    title: 'UDP SSDP Reflection',
    proto: 'UDP',
    drs: 3,
    reproducible: true,
    note: 'Synthetic SSDP/UPnP-shape amplification (no real device, no spoofing).',
  },
  {
    id: 'udp_cldap_reflection',
    title: 'UDP CLDAP Reflection',
    proto: 'UDP',
    drs: 4,
    reproducible: true,
    note: 'Synthetic CLDAP-shape amplification profile (no real directory, no spoofing).',
  },
  {
    id: 'udp_memcached_reflection',
    title: 'UDP Memcached Reflection',
    proto: 'UDP',
    drs: 4,
    reproducible: true,
    note: 'Synthetic memcached-shape amplification (very high factor, modelled — no real server, no spoofing).',
  },
  {
    id: 'quic_init_pressure',
    title: 'QUIC Init-Handshake Pressure',
    proto: 'UDP',
    drs: 4,
    reproducible: true,
    note: 'Bounded QUIC/UDP initial-handshake flood shape (real source, capped, no spoofing).',
  },
  {
    id: 'tcp_conn_drain',
    title: 'TCP Slow Connection Drain',
    proto: 'TCP',
    drs: 4,
    reproducible: true,
    note: 'No-spoof slow connection drain — holds bounded REAL connections to pressure the state table.',
  },
  {
    id: 'pulsewave_l34',
    title: 'PulseWave (L3/4 synchronized bursts)',
    proto: 'UDP',
    drs: 5,
    reproducible: true,
    note: 'Synthetic pulsed packet-rate bursts (PulseWave shape) — bounded, real source, no spoofing.',
  },
];

const DISPATCHABLE = new Set(BENCH_SCENARIOS.filter((s) => s.reproducible).map((s) => s.id));

/**
 * Ordered class-C (network-bench) ladders — the synthetic, no-spoof companion to
 * an L7 playbook. The control plane NEVER executes these; a CISO records the
 * bench-run requests, the isolated lab fulfils them, and the read-only verdicts
 * fuse into the WRS as class-C evidence. Every scenario in a ladder is
 * `reproducible` (asserted by `benchLadderScenarios`).
 */
export interface BenchLadder {
  id: string;
  title: string;
  summary: string;
  /** Ordered `BENCH_SCENARIOS` ids, DRS 3 → 5. All must be reproducible. */
  scenarios: string[];
}

export const CLASS_C_LADDERS: BenchLadder[] = [
  {
    id: 'network-drs345',
    title: 'Network resilience — class-C DRS 3→5',
    summary:
      'A synthetic, no-spoof network-bench ladder (UDP amplification shapes + TCP connection ' +
      'pressure), escalating DRS 3→5. The class-C companion to an L7 playbook: run on the ' +
      'isolated bench, its verdicts feed the WRS read-only. No real reflector, no spoofing.',
    scenarios: [
      'udp_dns_reflection', // DRS3 — reflection shape
      'udp_ntp_reflection', // DRS3
      'tcp_synflood', // DRS3 — no-spoof state-table pressure
      'udp_maxpackets', // DRS3 — PPS path
      'udp_ssdp_reflection', // DRS3
      'tcp_maxpackets', // DRS3 — connection-table churn
      'udp_cldap_reflection', // DRS4
      'quic_init_pressure', // DRS4
      'tcp_conn_drain', // DRS4 — slow drain
      'udp_memcached_reflection', // DRS4 — high factor
      'udp_multivector', // DRS4 — combined UDP profiles
      'pulsewave_l34', // DRS5 — synchronized bursts
    ],
  },
];

/** Resolve a ladder id to its ordered scenarios; throws if any is not a known
 *  reproducible scenario (a curated ladder must never reference an out-of-model
 *  or non-dispatchable vector). Pure. */
export function benchLadderScenarios(ladderId: string): BenchScenario[] {
  const ladder = CLASS_C_LADDERS.find((l) => l.id === ladderId);
  if (!ladder) throw new Error(`unknown bench ladder: ${ladderId}`);
  return ladder.scenarios.map((id) => {
    const sc = BENCH_SCENARIOS.find((s) => s.id === id);
    if (!sc) throw new Error(`ladder ${ladderId} references unknown scenario ${id}`);
    if (!sc.reproducible) {
      throw new Error(`ladder ${ladderId} references non-reproducible scenario ${id}`);
    }
    return sc;
  });
}

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
  const cx = (v.connections ?? null) as Record<string, unknown> | null;
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
    connections: cx
      ? {
          opened: num(cx.opened),
          accepted: num(cx.accepted),
          refused: num(cx.refused),
          concurrentPeak: num(cx.concurrentPeak),
          capacity: num(cx.capacity),
          saturationPct: num(cx.saturationPct),
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

// --- Structured attestation checklists -------------------------------------
//
// For the out-of-model vectors — the ones this bench can NEVER emit (spoofing,
// GRE, fragment crafting) — the honest form of coverage is *verification of a
// control*, not simulation. A free-text ATTESTED note works, but a structured
// checklist keyed to the relevant standard (BCP38/uRPF, GRE-drop, fragment
// reassembly limits) makes the evidence auditable and repeatable: the CISO
// ticks the controls that are actually enforced, and the bench derives a
// deterministic PASS / PARTIAL / FAIL outcome and a structured summary. No
// traffic is generated; this only records what is already configured at the
// edge. The result is stored as a normal ATTESTED BenchCoverage entry, so it
// flows into the same coverage matrix and assessment report.

export interface AttestationItem {
  id: string;
  label: string;
  required: boolean;
}

export interface AttestationChecklist {
  id: string;
  vector: string; // a BENCH_SCENARIOS id (typically an out-of-model one)
  title: string;
  standard: string; // the control/standard this attests to
  guidance: string;
  items: AttestationItem[];
}

export const ATTESTATION_CHECKLISTS: AttestationChecklist[] = [
  {
    id: 'bcp38-urpf',
    vector: 'ip_spoofing',
    title: 'Anti-spoofing (BCP38 / uRPF)',
    standard: 'BCP 38 (RFC 2827) + uRPF (RFC 3704)',
    guidance:
      'Source-address validation at the edge. This bench never emits spoofed sources by construction; coverage for this vector is the enforcement evidence below.',
    items: [
      {
        id: 'ingress_acl',
        label: 'Ingress ACLs drop packets with source outside advertised prefixes',
        required: true,
      },
      {
        id: 'urpf',
        label: 'uRPF enabled on customer/edge interfaces (strict or feasible)',
        required: true,
      },
      {
        id: 'urpf_strict',
        label: 'uRPF in strict mode where topology is symmetric',
        required: false,
      },
      { id: 'bogon', label: 'Bogon / martian source filtering in place', required: true },
      { id: 'audited', label: 'Filters audited within the last review cycle', required: false },
    ],
  },
  {
    id: 'gre-drop',
    vector: 'gre_packets',
    title: 'GRE / tunnel-protocol handling',
    standard: 'Edge protocol policy (GRE, protocol 47)',
    guidance:
      'GRE is not a UDP amplification shape and is out of this bench’s model. Coverage is the edge policy that drops or rate-limits unsolicited GRE.',
    items: [
      {
        id: 'default_drop',
        label: 'Unsolicited GRE (proto 47) dropped by default at the edge',
        required: true,
      },
      {
        id: 'allowlist',
        label: 'GRE permitted only between known tunnel endpoints (allowlist)',
        required: true,
      },
      { id: 'ratelimit', label: 'GRE rate-limited / policed on ingress', required: false },
      {
        id: 'telemetry',
        label: 'GRE volume observable in flow telemetry / alerting',
        required: false,
      },
    ],
  },
  {
    id: 'frag-reassembly',
    vector: 'udp_fragmentation',
    title: 'IP fragmentation handling (UDP)',
    standard: 'Fragment reassembly limits / drop policy',
    guidance:
      'Fragment crafting is outside the synthetic model (no raw packet crafting). Coverage is the reassembly-limit and tiny-fragment drop policy at the edge.',
    items: [
      {
        id: 'reassembly_cap',
        label: 'Per-source reassembly buffers capped (anti fragment-exhaustion)',
        required: true,
      },
      { id: 'tiny_frag', label: 'Tiny / overlapping fragments dropped', required: true },
      {
        id: 'frag_ratelimit',
        label: 'Fragmented traffic rate-limited on ingress',
        required: false,
      },
      { id: 'timeout', label: 'Short reassembly timeout enforced', required: false },
    ],
  },
  {
    id: 'frag-reassembly-tcp',
    vector: 'tcp_fragmentation',
    title: 'IP fragmentation handling (TCP)',
    standard: 'Fragment reassembly limits / drop policy',
    guidance:
      'TCP + fragment crafting is out of model. Coverage is the reassembly-limit and overlapping-fragment drop policy at the edge.',
    items: [
      { id: 'reassembly_cap', label: 'Per-source reassembly buffers capped', required: true },
      { id: 'overlap_drop', label: 'Overlapping / inconsistent fragments dropped', required: true },
      { id: 'mss_clamp', label: 'MSS clamping / PMTUD sanity enforced', required: false },
      { id: 'timeout', label: 'Short reassembly timeout enforced', required: false },
    ],
  },
];

const CHECKLIST_BY_ID = new Map(ATTESTATION_CHECKLISTS.map((c) => [c.id, c]));

/**
 * Turns a completed attestation checklist (untrusted request body) into an
 * ATTESTED coverage entry. The CISO submits the checklist id and the set of
 * item ids they attest are enforced; the outcome and a structured, deterministic
 * summary are derived here (never taken from the client), so two identical
 * submissions produce identical evidence.
 */
export function parseAttestationInput(
  input: unknown,
  recordedBy: string,
): Omit<BenchCoverage, 'id' | 'at'> {
  const b = (input ?? {}) as Record<string, unknown>;
  const checklist = CHECKLIST_BY_ID.get(String(b.checklistId ?? ''));
  if (!checklist) throw new Error('checklistId must be a known attestation checklist');
  const validIds = new Set(checklist.items.map((i) => i.id));
  const rawChecked = Array.isArray(b.checkedItems) ? b.checkedItems : [];
  const checked = new Set(rawChecked.map((x) => String(x)).filter((x) => validIds.has(x)));
  const requiredIds = checklist.items.filter((i) => i.required).map((i) => i.id);
  const requiredMet = requiredIds.every((id) => checked.has(id));
  const outcome: 'PASS' | 'PARTIAL' | 'FAIL' =
    checked.size === 0 ? 'FAIL' : requiredMet ? 'PASS' : 'PARTIAL';
  const note = String(b.note ?? '').trim();

  const lines = checklist.items.map(
    (i) => `${checked.has(i.id) ? '[x]' : '[ ]'} ${i.label}${i.required ? '' : ' (optional)'}`,
  );
  const summary = [
    `${checklist.title} — ${checklist.standard}`,
    `Controls attested: ${checked.size}/${checklist.items.length} (required ${requiredIds.filter((id) => checked.has(id)).length}/${requiredIds.length}).`,
    ...lines,
    ...(note ? [`Note: ${note}`] : []),
  ]
    .join('\n')
    .slice(0, 2000);

  return {
    vector: checklist.vector,
    method: 'ATTESTED',
    outcome,
    summary,
    source: checklist.standard.slice(0, 120),
    recordedBy,
  };
}

// --- External verdict import (INGESTED_EXTERNAL) ---------------------------
//
// The network team runs the real L3/4 bench for the vectors this synthetic
// bench can never emit (spoofing, GRE, fragmentation, multi-proto combos).
// Rather than transcribe their results one row at a time, a CISO can import a
// batch — the export their bench produces — as read-only INGESTED_EXTERNAL
// coverage. Nothing is executed or emitted here; this only records verdicts
// measured elsewhere, honestly labelled as external. Every row is validated
// against the catalogue and clamped; a row that fails is reported, not
// silently dropped, so the import is auditable.

export interface IngestRowError {
  row: number;
  error: string;
}
export interface ParsedIngest {
  entries: Omit<BenchCoverage, 'id' | 'at'>[];
  errors: IngestRowError[];
}

function ingestRow(
  raw: Record<string, unknown>,
  recordedBy: string,
  defaultSource: string,
): Omit<BenchCoverage, 'id' | 'at'> {
  const vector = String(raw.vector ?? '').trim();
  if (!CATALOGUE_IDS.has(vector)) throw new Error(`unknown vector "${vector || '(empty)'}"`);
  const summary = String(raw.summary ?? '').trim();
  if (!summary) throw new Error('summary is required');
  const drsRaw = raw.drs;
  const drsNum = typeof drsRaw === 'number' ? drsRaw : Number(drsRaw);
  const drs = Number.isFinite(drsNum) && drsNum > 0 ? drsNum : undefined;
  const source = String(raw.source ?? '').trim() || defaultSource;
  return {
    vector,
    method: 'INGESTED_EXTERNAL',
    outcome: raw.outcome ? String(raw.outcome).slice(0, 40) : undefined,
    drs,
    summary: summary.slice(0, 2000),
    source: source.slice(0, 120),
    recordedBy,
  };
}

/** Minimal RFC-4180-ish CSV row splitter (handles quotes + escaped quotes). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parses an external-verdict batch into INGESTED_EXTERNAL coverage entries.
 * `format` is 'json' (an array of row objects, or `{ rows: [...] }`) or 'csv'
 * (a header row naming columns vector/outcome/drs/summary/source, then data).
 * Returns valid entries plus a per-row error list; throws only on unusable input.
 */
export function parseIngestBatch(
  data: unknown,
  format: 'json' | 'csv',
  recordedBy: string,
  defaultSource = 'network-team-bench',
): ParsedIngest {
  const rows: Record<string, unknown>[] = [];
  if (format === 'csv') {
    const text = String(data ?? '').trim();
    if (!text) throw new Error('empty CSV');
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]);
      const obj: Record<string, unknown> = {};
      header.forEach((h, idx) => (obj[h] = cells[idx]));
      rows.push(obj);
    }
  } else {
    let arr: unknown = data;
    if (typeof data === 'string') {
      try {
        arr = JSON.parse(data);
      } catch {
        throw new Error('invalid JSON');
      }
    }
    if (arr && typeof arr === 'object' && !Array.isArray(arr) && 'rows' in arr) {
      arr = (arr as { rows: unknown }).rows;
    }
    if (!Array.isArray(arr)) throw new Error('JSON must be an array of rows (or { rows: [...] })');
    for (const r of arr) rows.push((r ?? {}) as Record<string, unknown>);
  }

  if (rows.length === 0) throw new Error('no rows to import');
  if (rows.length > 500) throw new Error('too many rows (max 500 per import)');

  const entries: Omit<BenchCoverage, 'id' | 'at'>[] = [];
  const errors: IngestRowError[] = [];
  rows.forEach((r, idx) => {
    try {
      entries.push(ingestRow(r, recordedBy, defaultSource));
    } catch (err) {
      errors.push({ row: idx + 1, error: (err as Error).message });
    }
  });
  return { entries, errors };
}
