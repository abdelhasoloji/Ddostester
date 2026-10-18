import { lsGet, lsSet, lsRemove } from './storage.js';

export interface FleetDeviceInput {
  siteId?: string;
  agentId: string;
  name: string;
  group: string;
  profile: 'sensor' | 'camera' | 'gateway' | 'generic';
  privateIp: string;
  notes: string;
}
export interface FleetDevice extends FleetDeviceInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  connection?: 'unenrolled' | 'awaiting' | 'online' | 'offline' | 'revoked' | 'expired';
  lastSeenAt?: string | null;
  agentVersion?: string | null;
  enrollmentExpiresAt?: string | null;
}
export interface FleetEnrollment {
  schema: 'ddostester.fleet.enrollment/v1';
  deviceId: string;
  agentId: string;
  privateIp: string;
  token: string;
  expiresAt: string;
}

export type CampaignStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'KILLED_AUTO'
  | 'KILLED_MANUAL'
  | 'CANCELLED';

export interface WrsBreakdown {
  detection: number;
  mitigation: number;
  availability: number;
  collateral: number;
  wrs: number;
  level: 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
  estimated?: boolean;
}
export interface DurableFleetEvidence {
  sha256: string;
  content: {
    schema: 'ddostester.fleet.persisted-evidence/v1';
    runId: string;
    campaignId: string;
    state: string;
    counterCoverage: { reportedAgents: number; expectedAgents: number | null };
    shards: {
      agentId: string;
      state: string;
      result: null | { podIp?: string; generator?: { totalRequests?: number } | null };
    }[];
    wrs: null;
    probe: null;
  };
}

export interface Campaign {
  drsMode?: 'engine-validation' | 'synthetic-lab' | 'measured';
  drsDocument?: DrsCampaignView['document'];
  drsProfileId?: string;
  body?: string;
  headers?: Record<string, string>;
  fleetDeviceIds?: string[];
  iotProfile?: { id: 'sensor-heartbeat/v1'; seed: number; deviceIndex: number };
  id: string;
  name: string;
  target: string;
  probeUrl: string;
  /** Optional independent reference vantage (canary) for outage attribution. */
  referenceUrl?: string;
  probeVantage?: 'local' | 'remote';
  vector: string;
  status: CampaignStatus;
  createdBy: string;
  approvedBy?: string;
  /** Mandatory CISO sign-off (dual control) — present once a CISO co-signs. */
  cisoApprovedBy?: string;
  cisoApprovedAt?: string;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  scheduledAt?: string;
  scenario?: { maxRps: number; durationSec: number }[];
  agent?: string;
  recurrence?: { intervalMin: number; until?: string };
  flow?: RequestStep[];
  endpoints?: WeightedEndpoint[];
  userAgents?: string[];
  dataset?: Record<string, string>[];
  /** Cache-busting: unique query param per request so no cache serves it. */
  cacheBust?: boolean;
  /** No keep-alive: a fresh connection per request (connection-accept pressure). */
  noKeepAlive?: boolean;
  /** Parallel generation (mono-box): N concurrent vegeta workers, each at rate/N. */
  parallelism?: number;
  /** Closed-loop rate calibration (GEN-1): grade at the measured deliverable rate. */
  calibrate?: boolean;
  acceptance?: AcceptanceCriteria;
  assertion?: ResponseAssertion;
  acceptanceResult?: AcceptanceResult;
  suiteId?: string;
  suiteName?: string;
  suiteOrder?: number;
  wrs?: WrsBreakdown;
  runId?: string;
  /** Why the latest run ended as it did (set for a kill), mirrored from the run. */
  statusDetail?: string;
  createdAt?: string;
  /** Latest run's generator wall-clock (mirrored at settle time). */
  startedAt?: string;
  finishedAt?: string;
  durationSec?: number;
  /** Hidden from the default campaigns view (organisational state). */
  archived?: boolean;
}

export interface AcceptanceCriteria {
  maxP95Ms?: number;
  maxErrorRatePct?: number;
  minAvailabilityPct?: number;
  minWrs?: number;
  maxAssertionFailurePct?: number;
}

export interface ResponseAssertion {
  status?: number;
  bodyContains?: string;
}

export interface WeightedEndpoint {
  method?: string;
  url: string;
  body?: string;
  weight?: number;
}

export interface AcceptanceResult {
  verdict: 'PASS' | 'FAIL';
  failures: string[];
}

export interface ThreatInfo {
  technique: string;
  reference: string;
  /** Link to the authoritative public source (Cloudflare DDoS report, CVE, CERT, OWASP…). */
  source?: string;
  measures: string;
  notReproduced: string;
}

export interface Playbook {
  id: string;
  name: string;
  category: string;
  summary: string;
  when: string;
  custom?: boolean;
  threat?: ThreatInfo;
  drsLevel?: number;
  /** Target features this template needs to produce a meaningful verdict — a
   *  benign result on a target that lacks one means "not applicable", not "the
   *  target resisted". */
  requires?: ('h2' | 'waf' | 'cache' | 'dynamic')[];
  createdAt?: string;
  /** Class-C network-bench companion (synthetic, no-spoof) paired with this L7
   *  template for a cross-layer assessment — run on the isolated bench, fused
   *  read-only into the WRS. */
  companionBench?: { ladder: string; note: string };
  steps: {
    name: string;
    summary: string;
    maxRps: number;
    concurrency: number;
    maxDurationSec: number;
    profile: string;
    vector?: string;
    agent?: string;
    paths?: string[];
    rotateUa?: boolean;
    headers?: Record<string, string>;
  }[];
}

export interface RequestStep {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
  thinkMs?: number;
  name?: string;
  extract?: { name: string; from: 'json' | 'header' | 'regex'; expr: string };
}

export interface RunSample {
  /** Explicit provenance; absent on historical samples. */
  generatorObserved?: boolean;
  successful?: number;
  probeSamples?: number;
  probeP95?: number;
  /** Cumulative snapshots, not interpolated transactions. */
  probeAvailable?: number;
  probeLatencyMs?: { p50: number; p95: number; p99: number };
  probeEndpoints?: { url: string; samples: number; available: number }[];
  statusCounts?: Record<string, number>;
  sampleUnit?: 'requests' | 'connections';
  t: number;
  rps: number;
  sent: number;
  failed: number;
  probe5xx: number;
  availPct: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  available: boolean;
  multiPhase: boolean;
  flowCapable: boolean;
  description: string;
}

/** Faithful per-run verdict from the backend assessment engine (mirrors VectorAssessment). */
export type RunVerdict = 'held' | 'partial' | 'breached' | 'inconclusive';
export type RunMechanism = 'served' | 'rejected' | 'tarpitted' | 'shed' | 'blocked' | 'unknown';

/** An edge-served error page captured under load (mirrors backend EdgeErrorSignal). */
export interface EdgeErrorSignal {
  status: number;
  layer: 'origin' | 'rate-limit' | 'challenge' | 'edge';
  vendor?: string;
  node?: string;
  reqId?: string;
  server?: string;
  protocol?: string;
  /** Origin IP leaked by the page — an information-disclosure FINDING, never a target. */
  originIpLeaked?: string;
}
export interface RunAssessment {
  expectedRps?: number;
  isSlowConnection?: boolean;
  verdict: RunVerdict;
  mechanism: RunMechanism;
  /** One faithful sentence describing what happened. */
  observation: string;
  /** Under-delivery / degraded / probe-contended notes — why a verdict may be inconclusive. */
  caveats: string[];
  underDelivered: boolean;
  /** Whether the measurement is trustworthy enough to state resilience at the target rate. */
  confident: boolean;
  deliveryRatio: number;
  achievedRps: number;
  configuredRps: number;
}

export interface FleetStatus {
  configured: boolean;
  available: boolean;
  image?: string | null;
  observedAt?: string;
  run?: { runId: string; state: string; controlLeaseExpired: boolean } | null;
  agents?: {
    agentId: string;
    state: string;
    attemptId: string;
    leaseExpired: boolean;
    leaseUntil: number;
    budget: { maxRps: number; concurrency: number; durationSec: number };
    progress: { sent: number; successful: number; failed: number } | null;
    progressAt: number | null;
  }[];
}

export interface CampaignRun {
  runId: string;
  campaignId: string;
  status: CampaignStatus;
  /** Human-readable explanation of the terminal status (e.g. why an auto-kill fired). */
  statusDetail?: string;
  /** The engine that ACTUALLY ran (may differ from the configured agent when a
      high-rate step was auto-routed off the built-in engine). */
  engine?: string;
  /** The probe lost the connection race to the flood (read the target as down
      while the generator was serving it) — availability was taken from the
      generator's success ratio, not the probe's, and no false auto-kill fired. */
  probeContended?: boolean;
  measurementPolicy?: 'independent-probe-v1' | 'multi-route-probe-v2';
  /** Breaking point: the offered rps at which the target started failing en masse,
      and the highest rps it sustained cleanly. */
  breakingPoint?: {
    reached: boolean;
    rps?: number;
    atSec?: number;
    failRate?: number;
    sustainedRps: number;
  };
  generator: {
    config?: { slowloris?: boolean; maxRps?: number };
    startedAt?: string;
    finishedAt?: string;
    fleet?: {
      receiverEvidence?: {
        matched: boolean;
        totalReceipts: number;
        successfulReceipts: number;
        sourceIps: string[];
        provenance: string;
        recordedAt: string;
        agents: { agentId: string; receipts: number; successful: number; matched: boolean }[];
      };
      startup?: {
        schema: 'ddostester.fleet.startup/v1';
        scope: 'generator-timestamps-relative-to-parent';
        reportedAgents: number;
        expectedAgents: number;
        firstGeneratorStartDelayMs: number | null;
        lastGeneratorStartDelayMs: number | null;
        agents: { agentId: string; generatorStartDelayMs: number | null }[];
      };
      counterCoverage?: {
        reportedAgents: number;
        expectedAgents: number;
        scope: 'received-final-results-only';
      };
      measurementComplete: boolean;
      shards: {
        agentId: string;
        state: string;
        attemptId: string;
        leaseUntil: number;
        assignmentHash?: string;
        budget?: { maxRps: number; concurrency: number; durationSec: number };
        result?: {
          generator?: unknown;
          podIp?: string;
          podUid?: string;
          reason?: string;
          resources?: {
            processRssBytesAtFinish: number;
            processCpuUserUsec: number;
            processCpuSystemUsec: number;
            cgroupThrottledUsecDelta: number | null;
            elapsedMs: number;
          };
        };
      }[];
    };
    totalRequests: number;
    finalizedRequests?: number;
    unfinalizedRequests?: number;
    successful: number;
    failed: number;
    actualRps: number;
    latencyMs: { min: number; max: number; mean: number; p50: number; p95: number; p99: number };
    latencySampleCount?: number;
    latencyMethod?:
      'native-combined-results' | 'common-histogram-upper-bounds' | 'native-rounded-response-times';
    statusCounts: Record<string, number>;
    errors: Record<string, number>;
    assertionsChecked?: number;
    assertionFailures?: number;
    hardStopped?: boolean;
  };
  probe: {
    endpoints?: { url: string; samples: number; available: number }[];
    quality?: {
      measuredSamples: number;
      totalSamples: number;
      peakEventLoopDelayMs: number | null;
      peakRecentEventLoopDelayMs?: number | null;
      eventLoopMeasuredSamples?: number;
      peakThrottledFraction: number | null;
      latest?: { cpuUserUsec: number; cpuSystemUsec: number; rssBytes: number; sampledAt: string };
    };
    samples: number;
    available: number;
    errorRate5xx: number;
    latencyMs: { p50: number; p95: number; p99: number };
    successful: number;
  };
  wrs: WrsBreakdown;
  acceptance?: AcceptanceResult;
  timeline?: RunSample[];
  protectionSource?: string;
  protection?: { source?: string; detectionTimeSec: number; mitigationTimeSec: number };
  baseline?: {
    quality?: CampaignRun['probe']['quality'];
    samples: number;
    availabilityPct: number;
    latencyMs: { p50: number; p95: number };
    observation?: {
      vantage: 'remote';
      expectedSamples: number;
      receivedSamples: number;
      missingSamples: number;
      complete: boolean;
    };
  };
  recoveryBeforeRun?: {
    available: boolean;
    verified?: boolean;
    waitedMs: number;
    checks: number;
    quality?: CampaignRun['probe']['quality'];
    observation?: {
      vantage: 'remote';
      receivedSamples: number;
      missingSamples: number;
      complete: boolean;
    };
  };
  baselineDelta?: {
    latencyP50DeltaMs: number;
    latencyP95DeltaMs: number;
    availabilityDeltaPct: number;
  };
  /** Independent reference vantage — outage attribution (present when set). */
  reference?: {
    url: string;
    samples: number;
    available: number;
    availPct: number;
    targetAttributed: boolean;
  };
  targetTelemetry?: {
    receivedRequests?: number;
    receiptComplete?: boolean;
    at: string;
    cpuPct?: number;
    conntrack?: number;
    nicRxMbps?: number;
    nicTxMbps?: number;
  }[];
  posture?: {
    waf: boolean;
    cdn: boolean;
    rateLimiting: boolean;
    loadBalancer: boolean;
    hsts: boolean;
    securityHeaders: string[];
    server?: string;
    signals: string[];
  };
  /** Edge-served error pages captured under load — first-party impact evidence
   *  (the origin buckling behind a healthy edge, a rate-limit, or a challenge). */
  edgeErrors?: EdgeErrorSignal[];
  /** Protection absorption: configured → offered → origin RPS + % absorbed by the edge. */
  absorption?: Absorption;
  /** Faithful assessment from the backend engine — the same verdict the report shows,
   *  so the detail page and the report never disagree. */
  assessment?: RunAssessment;
  /** Measurement confidence — whether the generator host itself was the bottleneck. */
  confidence?: RunConfidence;
  /** Bilateral corroboration: our inferred absorption vs the edge's own report. */
  edgeCorroboration?: {
    ourAbsorbedRatio: number;
    edgeAbsorbedRatio: number;
    agreementDelta: number;
    agrees: boolean;
    source: string;
  };
}

export interface Absorption {
  configuredRps: number;
  achievedRps: number;
  originRps: number;
  absorbedRatio: number;
  absorbedPct: number;
  totalRequests: number;
  /** Backpressure: 1 - achieved/configured (latency-bound, not edge rejection). */
  offeredShortfall?: number;
  /** Fraction the edge rejected with a 4xx/5xx response. */
  rejectedRatio?: number;
  /** Fraction the edge tarpitted (held → timeout/abort). */
  tarpitRatio?: number;
}

export interface RunConfidence {
  degraded: boolean;
  reasons: string[];
  peakEventLoopLagMs?: number;
}

/** A protected zone's assurance posture (GET /api/zones). */
export interface ZoneSummary {
  host: string;
  campaigns: number;
  suites: number;
  running: boolean;
  lastWrs?: number;
  lastLevel?: WrsBreakdown['level'];
  meanWrs?: number;
  regression: boolean;
  lastAbsorbedPct?: number;
  maxDrs?: number;
  lastTestAt?: string;
}

/** Per-(target, vector) absorption rollup (GET /api/observability/summary). */
export interface AbsorptionSummaryRow {
  target: string;
  vector: string;
  runs: number;
  lastAt?: string;
  lastWrs?: number;
  meanWrs: number;
  lastAbsorbedPct: number;
  meanAbsorbedPct: number;
  lastRejectedPct: number;
  lastTarpitPct: number;
  lastOfferedShortfallPct: number;
}

/** A step that floored the target (GET /api/impact, E16). */
export interface ImpactEntry {
  runId: string;
  campaignId: string;
  name: string;
  target?: string;
  engine?: string;
  at?: string;
  availabilityPct: number;
  breakingRps?: number;
  sustainedRps?: number;
  autoKilled: boolean;
  wrs: number;
  severity: number;
  uncertain?: boolean;
}

/** In-app alert derived from run history (GET /api/alerts). */
export interface Alert {
  severity: 'critical' | 'warning' | 'info';
  key: string;
  kind:
    | 'tarpit'
    | 'low-wrs'
    | 'degraded'
    | 'auto-killed'
    | 'not-engaging'
    | 'wrs-regression'
    | 'protection-regression';
  title: string;
  detail: string;
  campaignId?: string;
  runId: string;
  target?: string;
  at?: string;
  /** Investigation context (E10). */
  engine?: string;
  durationSec?: number;
  metric?: { label: string; value: string };
}

/** A named Prometheus range series for the app-native charts (option B). */
export interface MetricsRange {
  name: string;
  title: string;
  unit: string;
  source: 'ok' | 'unavailable' | 'error';
  series: { label: string; points: [number, number][] }[];
}

export type Role = 'engineer' | 'ciso' | 'admin' | 'viewer';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  campaignId?: string;
  detail?: string;
}

export interface AuditVerdict {
  ok: boolean;
  count: number;
  headHash: string;
  brokenAt?: { index: number; id: string; reason: 'content' | 'link' | 'missing-hash' };
}

export interface WrsPoint {
  at: string;
  wrs: number;
  level: string;
  runId: string;
}
export interface WrsSeries {
  target: string;
  points: WrsPoint[];
  regression: boolean;
  drop: number;
}

let token: string | null = lsGet('token');
export function setToken(t: string | null): void {
  token = t;
  if (t) lsSet('token', t);
  else lsRemove('token');
}
export function getToken(): string | null {
  return token;
}

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return token ? { ...base, authorization: `Bearer ${token}` } : base;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      setToken(null);
      window.dispatchEvent(new Event('shieldtest:session-expired'));
    }
    const failure = data as { error?: string; diagnosticId?: string };
    const reference =
      typeof failure.diagnosticId === 'string' && /^[a-f0-9-]{36}$/i.test(failure.diagnosticId)
        ? ` (reference ${failure.diagnosticId})`
        : '';
    throw new Error((failure.error ?? res.statusText) + reference);
  }
  return data as T;
}

function get<T>(url: string): Promise<T> {
  return fetch(url, { headers: authHeaders() }).then((r) => json<T>(r));
}
function post<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: authHeaders(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => json<T>(r));
}
function patch<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'PATCH',
    headers: authHeaders(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => json<T>(r));
}
function put<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'PUT',
    headers: authHeaders(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => json<T>(r));
}
function del<T>(url: string): Promise<T> {
  return fetch(url, { method: 'DELETE', headers: authHeaders() }).then((r) => json<T>(r));
}

/** The operational limits and the immutable ceiling (GET/PUT /api/limits). */
export interface LimitsInfo {
  ceiling: HardCaps;
  effective: HardCaps;
}

// --- Network bench (class C) — governed record-and-dispatch ----------------
// The catalogue mirrors the DRS Volumetric matrix (report P25-20300):
// each vector carries its DRS level and whether this bench can reproduce it.
export interface BenchScenario {
  id: string;
  title: string;
  proto: 'UDP' | 'TCP' | 'IP' | 'Multi' | 'GRE';
  drs: number;
  reproducible: boolean;
  note: string;
}
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
export type BenchRunStatus = 'REQUESTED' | 'CLAIMED' | 'COMPLETED' | 'FAILED';
export interface BenchRun {
  id: string;
  scenario: string;
  labTarget: string;
  status: BenchRunStatus;
  requestedBy: string;
  requestedAt: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  verdict?: BenchVerdict;
  error?: string;
}
export interface BenchLadder {
  id: string;
  title: string;
  summary: string;
  /** Ordered BenchScenario ids, DRS 3→5. */
  scenarios: string[];
}
export interface BenchCatalogue {
  scenarios: BenchScenario[];
  ladders?: BenchLadder[];
  dispatchEnabled: boolean;
  labTargets: string[];
}
export type CoverageMethod =
  'MEASURED_LAB' | 'INGESTED_EXTERNAL' | 'ATTESTED' | 'MODELLED' | 'REPLAY';
// Methods a CISO can record by hand (MEASURED_LAB only comes from a real run).
export const RECORDABLE_METHODS: CoverageMethod[] = [
  'INGESTED_EXTERNAL',
  'ATTESTED',
  'MODELLED',
  'REPLAY',
];
export interface BenchCoverage {
  id: string;
  vector: string;
  method: CoverageMethod;
  outcome?: string;
  drs?: number;
  summary: string;
  source: string;
  recordedBy: string;
  at: string;
}
export interface CoverageInput {
  vector: string;
  method: CoverageMethod;
  outcome?: string;
  drs?: number;
  summary: string;
  source?: string;
}
export interface AttestationItem {
  id: string;
  label: string;
  required: boolean;
}
export interface AttestationChecklist {
  id: string;
  vector: string;
  title: string;
  standard: string;
  guidance: string;
  items: AttestationItem[];
}
export interface AttestationInput {
  checklistId: string;
  checkedItems: string[];
  note?: string;
}
export interface IngestResult {
  imported: number;
  errors: { row: number; error: string }[];
  records: BenchCoverage[];
}

/** Report URL for a browser link (HttpOnly read cookie when auth is enabled). */
export function reportUrl(runId: string): string {
  const u = `/api/runs/${runId}/report`;
  return u;
}

/** CSV export of all runs' aggregated metrics (HttpOnly read cookie when auth is enabled). */
export function runsCsvUrl(): string {
  const u = `/api/runs.csv`;
  return u;
}

/** CSV export of one run's per-second timeline. */
export function runTimelineCsvUrl(runId: string): string {
  const u = `/api/runs/${runId}/timeline.csv`;
  return u;
}

/** URL of the downloadable, self-verifiable audit export (entries + hashes). */
export function auditExportUrl(): string {
  const u = `/api/audit/export`;
  return u;
}

/** URL of the aggregated compliance report (DORA/NIS2). */
export function complianceUrl(): string {
  const u = `/api/reports/compliance`;
  return u;
}

/** URL of the before/after comparison of two runs (HttpOnly read cookie when auth is enabled). */
export function compareUrl(runIdA: string, runIdB: string): string {
  const q = `a=${encodeURIComponent(runIdA)}&b=${encodeURIComponent(runIdB)}`;
  const u = `/api/reports/compare?${q}`;
  return u;
}

/** Recon-seeding summary returned when a suite is instantiated. */
export interface ReconSeedInfo {
  seeded: boolean;
  go?: boolean;
  suggestedPaths?: string[];
  loginPath?: string;
  error?: string;
}

/** Structured before/after comparison of two runs (Mitigation Proof). */
export interface MetricDelta {
  key: string;
  label: string;
  unit?: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  betterWhenUp: boolean;
  improved: boolean | null;
}
export interface RunComparisonSide {
  runId: string;
  campaign: string;
  at: string;
  wrs: number;
  level: string;
  status: string;
}
export interface RunComparison {
  target: string;
  before: RunComparisonSide;
  after: RunComparisonSide;
  wrsDelta: number;
  levelBefore: string;
  levelAfter: string;
  verdict: 'improved' | 'regressed' | 'unchanged' | 'inconclusive';
  comparability?: { schema: string; comparable: boolean; reasons: string[] };
  headline: string;
  metrics: MetricDelta[];
  remainingRemediations: {
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    weakness: string;
    remediation: string;
  }[];
}

/** URL of an assessment suite's consolidated HTML report. */
export function suiteReportUrl(suiteId: string): string {
  const u = `/api/suites/${suiteId}/report`;
  return u;
}

/** URL of the before/after comparison of two suites (tune-and-replay loop). */
export function suiteCompareUrl(suiteIdA: string, suiteIdB: string): string {
  const q = `a=${encodeURIComponent(suiteIdA)}&b=${encodeURIComponent(suiteIdB)}`;
  const u = `/api/reports/suite-compare?${q}`;
  return u;
}

// ── Grafana deep-linking ──────────────────────────────────────────────────
// The observability stack (Prometheus + Grafana) lives outside the app; the
// user points the app at their Grafana base URL (a local SSH tunnel, or a
// reverse-proxied route) and the Run Theater / Results can deep-link into the
// provisioned "ShieldTest — Runs" dashboard, scoped to a run's target + window.
const GRAFANA_BASE_KEY = 'shieldtest.grafana.base';

/** The provisioned ShieldTest dashboards (uids), by observability plane. */
export const GRAFANA_DASHBOARDS = {
  run: 'shieldtest-run',
  drs: 'shieldtest-drs',
  resilience: 'shieldtest-resilience',
  platform: 'shieldtest-platform',
} as const;
export type GrafanaPlane = keyof typeof GRAFANA_DASHBOARDS;

/** The configured Grafana base URL (no trailing slash), or '' when unset. */
export function getGrafanaBase(): string {
  return lsGet(GRAFANA_BASE_KEY) ?? '';
}

/** Persist (or clear, when empty) the Grafana base URL for this browser. */
export function setGrafanaBase(url: string): void {
  const v = url.trim().replace(/\/+$/, '');
  if (v) lsSet(GRAFANA_BASE_KEY, v);
  else lsRemove(GRAFANA_BASE_KEY);
}

/**
 * Deep link into one of the ShieldTest Grafana dashboards (a plane of the
 * observability model), optionally scoped to a target and time window.
 * `fromMs`/`toMs` are epoch millis (Grafana's native range); when omitted it
 * defaults to the last 15 minutes with live refresh.
 */
export function grafanaDashUrl(
  base: string,
  plane: GrafanaPlane,
  opts: {
    target?: string;
    campaignId?: string;
    revisionId?: string;
    fromMs?: number;
    toMs?: number;
  } = {},
): string {
  const p = new URLSearchParams();
  p.set('from', opts.fromMs ? String(opts.fromMs) : 'now-15m');
  p.set('to', opts.toMs ? String(opts.toMs) : 'now');
  if (!opts.toMs) p.set('refresh', '5s');
  if (opts.target) p.set('var-target', opts.target);
  if (opts.campaignId) p.set('var-campaign', opts.campaignId);
  if (opts.revisionId) p.set('var-revision', opts.revisionId);
  return `${base.replace(/\/+$/, '')}/d/${GRAFANA_DASHBOARDS[plane]}?${p.toString()}`;
}

/** Deep link into the live Run & Absorption dashboard (Run Theater). */
export function grafanaRunUrl(
  base: string,
  opts: { target?: string; fromMs?: number; toMs?: number } = {},
): string {
  return grafanaDashUrl(base, 'run', opts);
}

/** URL of a campaign's real-time progress SSE stream (EventSource). */
export function streamUrl(campaignId: string): string {
  const u = `/api/campaigns/${campaignId}/stream`;
  return u;
}

export interface LiveProgressData {
  generatorObserved?: boolean;
  sent: number;
  successful: number;
  failed: number;
  elapsedSec: number;
  actualRps: number;
  maxDurationSec: number;
  status: 'RUNNING';
  engine?: string;
  /** Live latency percentiles (ms) — built-in engine only. */
  latencyMs?: { p50: number; p95: number; p99: number };
  /** Live HTTP status buckets so far (`2xx`/`3xx`/`4xx`/`5xx`). */
  statusCounts?: Record<string, number>;
  /** Rolling last-60s per-second series for the live sparkline. */
  timeline?: RunSample[];
  probe?: {
    endpoints?: { url: string; samples: number; available: number }[];
    samples: number;
    available: number;
    errorRate5xx: number;
    /** Probe's own live latency percentiles (ms). */
    latencyMs?: { p50: number; p95: number; p99: number };
    /** Graduated target-health verdict, surfaced before any hard auto-kill. */
    health?: 'ok' | 'degraded' | 'critical';
  };
}

/**
 * The server's HARD_CAPS, delivered by `/health`. The backend
 * (`backend/src/config/limits.ts`) is the single source of truth; the frontend
 * never hardcodes these — it displays whatever the server reports. `DEFAULT_CAPS`
 * is a pre-load fallback for inline hints only; the backend always enforces the
 * real caps regardless.
 */
export interface HardCaps {
  maxRps: number;
  maxConcurrency: number;
  maxDurationSec: number;
}
export const DEFAULT_CAPS: HardCaps = { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 };

/** Assistant GPU-pod power state (RunPod stop/resume). */
export type PodState = 'RUNNING' | 'STARTING' | 'STOPPED' | 'UNKNOWN';
export interface PodStatus {
  configured: boolean;
  state: PodState;
  uptimeSec?: number;
  error?: string;
}

/** Protected target (governed onboarding). */
export type TargetAuthStatus = 'unauthorized' | 'requested' | 'authorized' | 'revoked';
export interface ProtectedTarget {
  id: string;
  host: string;
  displayName?: string;
  notes?: string;
  owner?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  authStatus: TargetAuthStatus;
  authAttestation?: string;
  authRequestedBy?: string;
  authRequestedAt?: string;
  authorizedBy?: string;
  authorizedAt?: string;
  revokedBy?: string;
  revokedAt?: string;
}
export interface RegisterTargetInput {
  host: string;
  displayName?: string;
  notes?: string;
  owner?: string;
  /** When present, also requests authorization in the same call. */
  attestation?: string;
}

/** Read-only mitigation validation (TTD/TTM tier). */
export type MitigationVerdict =
  | 'mitigated'
  | 'partial'
  | 'not-exercised'
  | 'not-engaged'
  | 'no-measurement'
  | 'insufficient-data';
export interface MitigationWindow {
  fromSec: number;
  toSec: number;
  samples: number;
  absorbedRatio: number;
  availabilityPct: number;
}
export interface MitigationValidation {
  ttdSec?: number;
  ttmSec?: number;
  source?: string;
  before?: MitigationWindow;
  after?: MitigationWindow;
  absorbedDelta?: number;
  availabilityDelta?: number;
  wrsBefore?: number;
  wrsAfter?: number;
  wrsDelta?: number;
  theoretical?: boolean;
  verdict: MitigationVerdict;
  note: string;
}

export interface AccessContract {
  capabilities?: string[];
  contractVersion?: number;
  primaryAdminEmail?: string;
  approvalPolicy?: 'confirmation' | 'dual_control';
  userMode?: 'team' | 'single';
}

export const api = {
  drsValidation: (maxLevel = 1) => post<Campaign>('/api/drs/validations', { maxLevel }),
  drsReference: () => get<DrsReferenceView>('/api/drs/reference'),
  drsCampaign: (id: string) => get<DrsCampaignView>(`/api/campaigns/${encodeURIComponent(id)}/drs`),
  drsAction: (id: string, action: string, body: unknown) =>
    post<unknown>(
      `/api/campaigns/${encodeURIComponent(id)}/drs/${encodeURIComponent(action)}`,
      body,
    ),
  drsReport: (id: string, revision: number) =>
    get<DrsReportView>(
      `/api/campaigns/${encodeURIComponent(id)}/drs/report.json?revision=${revision}`,
    ),
  fleetEvidenceForCampaign: (campaignId: string) =>
    get<DurableFleetEvidence>(
      `/api/fleet/campaigns/${encodeURIComponent(campaignId)}/evidence.json`,
    ),
  health: () =>
    fetch('/health').then((r) =>
      json<{
        status: string;
        version?: { version: string; build: string; commit: string; builtAt?: string };
        requireCisoApproval?: boolean;
        allowedTargets: string[];
        remoteProbe?: boolean;
        labTargets?: string[];
        storage: string;
        authRequired: boolean;
        userMode?: 'team' | 'single';
        drsWorkflow?: boolean;
        agent?: string;
        notifications?: string[];
        protection?: boolean;
        tlsInsecure?: boolean;
        hardCaps?: HardCaps;
        hardCapsCeiling?: HardCaps;
        builtinCeilings?: { rps: number; concurrency: number };
        metrics?: { prometheus?: boolean; grafanaUrl?: string | null; runDashboardUid?: string };
      }>(r),
    ),
  login: (email: string, password: string) =>
    post<
      AccessContract & { token: string; email: string; role: Role; mustChangePassword?: boolean }
    >('/api/auth/login', { email, password }),
  me: () =>
    get<AccessContract & { email: string | null; role: Role | null; mustChangePassword?: boolean }>(
      '/api/auth/me',
    ),
  revokeOwnSessions: () =>
    post<AccessContract & { token: string; email: string; role: Role }>(
      '/api/auth/sessions/revoke',
    ),
  revokeUserSessions: (email: string) =>
    post<{ revoked: boolean }>(`/api/users/${encodeURIComponent(email)}/sessions/revoke`),
  logout: () => post<{ ok: boolean }>('/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<
      AccessContract & { token: string; email: string; role: Role; mustChangePassword: boolean }
    >('/api/auth/password', { currentPassword, newPassword }),
  listCampaigns: () => get<Campaign[]>('/api/campaigns'),
  createCampaign: (body: unknown) => post<Campaign>('/api/campaigns', body),
  approve: (id: string, body: unknown) => post<Campaign>(`/api/campaigns/${id}/approval`, body),
  cisoApprove: (id: string) => post<Campaign>(`/api/campaigns/${id}/ciso-approval`),
  execute: (id: string, confirmed = false) =>
    post<CampaignRun>(`/api/campaigns/${id}/execute`, confirmed ? { confirmed: true } : undefined),
  startExecution: (id: string, confirmed = false) =>
    post<{ campaignId: string; statusUrl: string }>(`/api/campaigns/${id}/execute`, {
      background: true,
      ...(confirmed ? { confirmed: true } : {}),
    }),
  kill: (id: string) => post<{ status: string }>(`/api/campaigns/${id}/kill`),
  cancelCampaign: (id: string, reason?: string) =>
    post<Campaign>(`/api/campaigns/${id}/cancel`, reason ? { reason } : undefined),
  archiveCampaign: (id: string, archived: boolean) =>
    post<Campaign>(`/api/campaigns/${id}/archive`, { archived }),
  archiveSuite: (id: string, archived: boolean) =>
    post<{ suiteId: string; archived: boolean; changed: number; total: number }>(
      `/api/suites/${id}/archive`,
      { archived },
    ),
  /** Admin purge (officer): permanently delete test campaigns + their runs. */
  purgeCampaigns: (scope: 'settled' | 'all') =>
    post<{ deleted: number; killedRunning: number; scope: string }>('/api/campaigns/purge', {
      scope,
    }),
  getRun: (runId: string) => get<CampaignRun>(`/api/runs/${runId}`),
  listRuns: () => get<CampaignRun[]>('/api/runs'),
  audit: (limit = 100) => get<AuditEntry[]>(`/api/audit?limit=${limit}`),
  alerts: (limit = 50) => get<Alert[]>(`/api/alerts?limit=${limit}`),
  impact: (limit = 20) => get<{ impact: ImpactEntry[] }>(`/api/impact?limit=${limit}`),
  observabilitySummary: () => get<AbsorptionSummaryRow[]>('/api/observability/summary'),
  /** Per-protected-zone assurance posture (WEDOS-Protection framing). */
  zones: () => get<ZoneSummary[]>('/api/zones'),
  /** Structured before/after comparison of two runs (Mitigation Proof). */
  compareRuns: (a: string, b: string) =>
    get<RunComparison>(
      `/api/reports/compare.json?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
    ),
  metricsRange: (
    series: string,
    opts: { target?: string; minutes?: number; step?: number; sinceSec?: number } = {},
  ) => {
    const p = new URLSearchParams({ series });
    if (opts.target) p.set('target', opts.target);
    if (opts.minutes) p.set('minutes', String(opts.minutes));
    if (opts.step) p.set('step', String(opts.step));
    // Scope the window to a run's elapsed span (Run Theater) so stale samples from
    // earlier runs against the same target don't bleed into the live chart.
    if (opts.sinceSec) p.set('sinceSec', String(Math.ceil(opts.sinceSec)));
    return get<MetricsRange>(`/api/metrics/range?${p.toString()}`);
  },
  verifyAudit: () => get<AuditVerdict>('/api/audit/verify'),
  wrsHistory: () => get<WrsSeries[]>('/api/wrs/history'),
  runMitigation: (runId: string) => get<MitigationValidation>(`/api/runs/${runId}/mitigation`),
  agents: () => get<{ default: string; agents: AgentInfo[] }>('/api/agents'),
  validateAssistantProposal: (proposal: Record<string, unknown>) =>
    post<{ requiresOperatorReview: true }>('/api/assistant/proposals/validate', proposal),
  assistantStatus: () =>
    get<{ configured: boolean; model: string; podManaged: boolean }>('/api/assistant/status'),
  fleetMissions: () => get<FleetMissionStatus>('/api/fleet/missions'),
  fleetOverview: () => get<FleetOverview>('/api/fleet/overview'),
  fleetCampaign: (id: string) =>
    get<FleetCampaignObservation>(`/api/fleet/campaigns/${encodeURIComponent(id)}`),
  launchFleetMission: (body: {
    deviceIds: string[];
    maxRps: number;
    concurrency: number;
    durationSec: number;
    confirmed: true;
  }) => post('/api/fleet/missions', body),
  stopFleetMission: (id: string) => post(`/api/fleet/missions/${encodeURIComponent(id)}/stop`),
  drsCatalog: () => get<DrsCatalog>('/api/drs/catalog'),
  fleetSites: () =>
    get<{
      sites: { id: string; devices: number; online: number }[];
      devices: number;
      limits: { maxDevices: number; maxSites: number; pageSize: number };
    }>('/api/fleet/sites'),
  fleetDevices: (options?: {
    page?: number;
    pageSize?: number;
    siteId?: string;
    search?: string;
  }) =>
    get<{ devices: FleetDevice[]; total?: number; page?: number; pageSize?: number }>(
      '/api/fleet/devices' +
        (options
          ? '?' +
            new URLSearchParams(
              Object.entries(options)
                .filter(([, v]) => v !== undefined && v !== '')
                .map(([k, v]) => [k, String(v)]),
            )
          : ''),
    ),
  enrollFleetDevice: (id: string) =>
    post<FleetEnrollment>(`/api/fleet/devices/${encodeURIComponent(id)}/enrollment`),
  revokeFleetDevice: (id: string) =>
    del<FleetDevice>(`/api/fleet/devices/${encodeURIComponent(id)}/enrollment`),
  saveFleetDevice: (body: FleetDeviceInput, id?: string) =>
    id
      ? put<FleetDevice>(`/api/fleet/devices/${encodeURIComponent(id)}`, body)
      : post<FleetDevice>('/api/fleet/devices', body),
  removeFleetDevice: (id: string) => del<void>(`/api/fleet/devices/${encodeURIComponent(id)}`),
  fleetStatus: () => get<FleetStatus>('/api/fleet/status'),
  assistantPod: () => get<PodStatus>('/api/assistant/pod'),
  assistantPodStart: () => post<PodStatus>('/api/assistant/pod/start'),
  assistantPodStop: () => post<PodStatus>('/api/assistant/pod/stop'),
  targets: () => get<{ targets: ProtectedTarget[]; envAllowlist: string[] }>('/api/targets'),
  registerTarget: (body: RegisterTargetInput) => post<ProtectedTarget>('/api/targets', body),
  updateTarget: (id: string, body: Partial<RegisterTargetInput>) =>
    patch<ProtectedTarget>(`/api/targets/${id}`, body),
  requestTargetAuth: (id: string, attestation: string) =>
    post<ProtectedTarget>(`/api/targets/${id}/request`, { attestation }),
  authorizeTarget: (id: string) => post<ProtectedTarget>(`/api/targets/${id}/authorize`),
  revokeTarget: (id: string) => post<ProtectedTarget>(`/api/targets/${id}/revoke`),
  deleteTarget: (id: string) => del<{ ok: boolean }>(`/api/targets/${id}`),
  notifyTest: () => post<{ delivered: boolean; sinks: string[] }>('/api/notify/test'),
  createShare: (ttlMinutes?: number) =>
    post<{ authRequired: boolean; token: string | null; ttlMinutes?: number; expiresAt?: string }>(
      '/api/share',
      { ttlMinutes },
    ),
  getLimits: () => get<LimitsInfo>('/api/limits'),
  setLimits: (caps: HardCaps) => put<LimitsInfo>('/api/limits', caps),
  benchScenarios: () => get<BenchCatalogue>('/api/bench/scenarios'),
  benchRuns: () => get<{ runs: BenchRun[] }>('/api/bench/runs'),
  createBenchRun: (scenario: string, labTarget?: string) =>
    post<BenchRun>('/api/bench/runs', labTarget ? { scenario, labTarget } : { scenario }),
  benchCoverage: () => get<{ coverage: BenchCoverage[] }>('/api/bench/coverage'),
  recordBenchCoverage: (input: CoverageInput) => post<BenchCoverage>('/api/bench/coverage', input),
  benchAttestations: () => get<{ checklists: AttestationChecklist[] }>('/api/bench/attestations'),
  submitAttestation: (input: AttestationInput) =>
    post<BenchCoverage>('/api/bench/attestations', input),
  importBenchCoverage: (format: 'json' | 'csv', data: string, source?: string) =>
    post<IngestResult>('/api/bench/coverage/import', { format, data, source }),
  listUsers: () => get<ManagedUser[]>('/api/users'),
  createUser: (body: { email: string; role: Role; password: string }) =>
    post<ManagedUser>('/api/users', body),
  updateUserRole: (email: string, role: Role) =>
    patch<ManagedUser>(`/api/users/${encodeURIComponent(email)}`, { role }),
  setUserStatus: (email: string, status: 'active' | 'disabled') =>
    patch<ManagedUser>(`/api/users/${encodeURIComponent(email)}`, { status }),
  resetUserPassword: (email: string, password: string) =>
    post<{ email: string; mustChangePassword: boolean }>(
      `/api/users/${encodeURIComponent(email)}/password`,
      { password },
    ),
  deleteUser: (email: string) =>
    del<{ deleted: string }>(`/api/users/${encodeURIComponent(email)}`),
  playbooks: () => get<Playbook[]>('/api/playbooks'),
  createPlaybook: (body: unknown) => post<Playbook>('/api/playbooks', body),
  deletePlaybook: (id: string) =>
    del<{ deleted: string }>(`/api/playbooks/${encodeURIComponent(id)}`),
  instantiatePlaybook: (
    id: string,
    body: { target: string; probeUrl?: string; recurrenceMin?: number },
  ) =>
    post<{ suiteId: string; campaigns: Campaign[]; recon: ReconSeedInfo }>(
      `/api/playbooks/${id}/instantiate`,
      body,
    ),
  /** Compose several templates into one suite (steps concatenated in order). */
  composeSuite: (body: {
    playbookIds: string[];
    name?: string;
    target: string;
    probeUrl?: string;
    recurrenceMin?: number;
  }) =>
    post<{ suiteId: string; campaigns: Campaign[]; recon: ReconSeedInfo }>(
      '/api/suites/compose',
      body,
    ),
  suites: () => get<SuiteSummary[]>('/api/suites'),
  approveSuite: (id: string) =>
    post<{ suiteId: string; approved: number; skipped: number }>(`/api/suites/${id}/approve`),
  rejectSuite: (id: string, reason: string) =>
    post<{ suiteId: string; rejected: number; skipped: number }>(`/api/suites/${id}/reject`, {
      reason,
    }),
  runSuite: (id: string, confirmed = false) =>
    post<{ suiteId: string; steps: number; started: boolean }>(
      `/api/suites/${id}/run`,
      confirmed ? { confirmed: true } : undefined,
    ),
  pauseSuite: (id: string) => post<{ suiteId: string; paused: boolean }>(`/api/suites/${id}/pause`),
  resumeSuite: (id: string) =>
    post<{ suiteId: string; paused: boolean }>(`/api/suites/${id}/resume`),
  cancelSuite: (id: string) =>
    post<{ suiteId: string; cancelled: boolean; killedCurrent: boolean }>(
      `/api/suites/${id}/cancel`,
    ),
  suiteSequences: () =>
    get<{ sequences: Record<string, SuiteSequenceState> }>('/api/suites/sequences'),
  gapAnalysis: (profile: ProtectionProfile, target?: string) =>
    post<GapAnalysis>('/api/reports/gap-analysis', { profile, target }),
  /** Seed the control profile from evidence (recon + prior runs + class-C lab). */
  inferProfile: (target?: string) =>
    post<InferredProfile>('/api/reports/gap-analysis/infer', { target }),
  /** The class-C lab's L3/4 network DRS ladder (network half of the plan). */
  networkLadder: () => get<NetworkLadder>('/api/reports/network-ladder'),
  recon: (target: string, probeUrl?: string) => {
    const q = new URLSearchParams({ target });
    if (probeUrl) q.set('probeUrl', probeUrl);
    return get<ReconReport>(`/api/recon?${q.toString()}`);
  },
  /** Recon + the ranked set of recon-suggested unitary actions (P7). */
  reconActions: (target: string, probeUrl?: string) => {
    const q = new URLSearchParams({ target, actions: '1' });
    if (probeUrl) q.set('probeUrl', probeUrl);
    return get<ReconWithActions>(`/api/recon?${q.toString()}`);
  },
  /** Compose tuned action seeds into a governed campaign (1) or suite (N). */
  composeActions: (body: { name?: string; campaigns: ActionSeed[] }) =>
    post<{ suiteId?: string; campaigns: Campaign[] }>('/api/suites/from-actions', body),
};

// ── Preparation-phase reconnaissance (recon) ────────────────────────────────

export type CacheBehavior = 'hit' | 'miss' | 'dynamic' | 'unknown';

export interface TargetProfile {
  posture: {
    waf: boolean;
    cdn: boolean;
    rateLimiting: boolean;
    loadBalancer: boolean;
    hsts: boolean;
    securityHeaders: string[];
    server?: string;
    signals: string[];
  };
  vendor?: string;
  protocols: { http2: boolean; http3: boolean };
  tls?: string;
  cache: CacheBehavior;
  server?: string;
}

export interface ReconSurface {
  paths: string[];
  loginPath?: string;
  sitemaps: string[];
  disallow: string[];
}

export interface ReconBaseline {
  samples: number;
  availabilityPct: number;
  latencyP50: number;
  latencyP95: number;
  latencyMean: number;
}

export interface PreflightItem {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export interface ReconReport {
  target: string;
  probeUrl: string;
  generatedAt: string;
  profile: TargetProfile;
  surface: ReconSurface;
  baseline: ReconBaseline;
  preflight: { items: PreflightItem[]; go: boolean };
  seededProfile: ProtectionProfile;
  suggestedPaths: string[];
  /** The dynamic/expensive subset of suggestedPaths — the best stress targets. */
  dynamicPaths?: string[];
  loginPath?: string;
}

export type TargetRequirement = 'h2' | 'waf' | 'cache' | 'dynamic';

/** A recon-seeded, tunable campaign seed (the backend CampaignInput shape). */
export interface ActionSeed {
  name: string;
  description?: string;
  target: string;
  probeUrl: string;
  vector: 'http-get' | 'http-post' | 'http-slowloris';
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  createdBy?: string;
  authorized?: boolean;
  endpoints?: { url: string; weight?: number }[];
  userAgents?: string[];
  headers?: Record<string, string>;
  cacheBust?: boolean;
  noKeepAlive?: boolean;
  parallelism?: number;
  calibrate?: boolean;
  scenario?: unknown;
  agent?: string;
  requires?: TargetRequirement[];
  reconPosture?: { h2: boolean; waf: boolean; cache: boolean; dynamic: boolean };
  [k: string]: unknown;
}

/** P7 — a recon-suggested, unitary, tunable candidate action. */
export interface SuggestedAction {
  id: string;
  title: string;
  summary: string;
  rationale: string[];
  category?: string;
  drs?: number;
  requires?: TargetRequirement[];
  applicable: boolean;
  naReasons?: TargetRequirement[];
  relevance: number;
  sourceTemplateId?: string;
  seed: ActionSeed;
}

export interface ReconWithActions extends ReconReport {
  actions: SuggestedAction[];
}

// ── Protection-gap analyzer (RPT-05) ────────────────────────────────────────

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

export type ControlStatus = 'present' | 'partial' | 'absent' | 'unknown';
export type ProtectionProfile = Partial<Record<ControlKey, ControlStatus>>;

/** Evidence behind an inferred control status (recon / prior run / class-C lab). */
export interface ControlEvidence {
  status: ControlStatus;
  source: 'recon' | 'run' | 'lab';
  note: string;
}
export interface InferredProfile {
  profile: ProtectionProfile;
  provenance: Partial<Record<ControlKey, ControlEvidence[]>>;
}

/** The class-C lab's L3/4 network DRS ladder (full-stack plan, network half). */
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
  weakest?: { drs: number; id: string; title: string };
  covered: number;
  total: number;
}
export type Priority = 'high' | 'medium' | 'low';

/** Controls a user can declare in the planner (labels mirror the backend). */
export const GAP_CONTROLS: { key: ControlKey; label: string }[] = [
  { key: 'rateLimiting', label: 'Request rate limiting' },
  { key: 'slowRequestTimeout', label: 'Slow-request / header timeout' },
  { key: 'http2Guard', label: 'HTTP/2 abuse guard (rapid-reset / continuation)' },
  { key: 'challenge', label: 'Bot challenge (JS / PoW / CAPTCHA)' },
  { key: 'originShielding', label: 'Origin shielding / edge 404' },
  { key: 'cacheKeyPolicy', label: 'Cache-key policy' },
  { key: 'urlAllowlist', label: 'URL / path allowlist' },
  { key: 'methodPolicy', label: 'HTTP method policy' },
  { key: 'wafSignatures', label: 'WAF signature ruleset' },
  { key: 'bruteForceProtection', label: 'Credential brute-force protection' },
  { key: 'synFloodProtection', label: 'SYN-flood / handshake protection (L3/4)' },
];

export interface ControlState {
  key: ControlKey;
  label: string;
  status: ControlStatus;
}

export interface GapIntensity {
  maxRps: number;
  concurrency: number;
  durationSec: number;
  profile: 'constant' | 'ramp' | 'wave';
}

export interface GapPlanItem {
  line: number;
  drs: number;
  tier: string;
  name: string;
  controls: ControlState[];
  weakest: ControlState;
  priority: Priority;
  score: number;
  step: string;
  /** Replayable single-step template for this line, when one exists. */
  templateId?: string;
  intensity?: GapIntensity;
  combination: boolean;
  rationale: string;
  attestedNote?: string;
}

export interface GapAttestationItem {
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
  plan: GapPlanItem[];
  attestationOnly: GapAttestationItem[];
  breakPoint: {
    line: number;
    name: string;
    drs: number;
    weakest: ControlState;
    note: string;
  } | null;
  summary: { high: number; medium: number; low: number; attested: number };
}

/** Live control state of an in-flight suite sequence (GET /api/suites/sequences). */
export interface SuiteSequenceState {
  paused: boolean;
  current?: string;
  started: number;
  total: number;
  /** Paused by the sequencer itself because the target looked genuinely down. */
  autoPaused?: boolean;
  /** Consecutive recovery-gate skips for an unreachable target. */
  downSkips?: number;
  /** Epoch ms when the recovery gate started waiting (present only while it is
   *  blocking); the UI counts up from here. */
  gateStartedAt?: number;
  /** The gate's max wait (ms) before it gives up and skips — for the countdown. */
  gateMaxWaitMs?: number;
}

export interface SuiteSummary {
  suiteId: string;
  suiteName: string;
  target: string;
  createdAt: string;
  total: number;
  pending: number;
  approved: number;
  running: number;
  completed: number;
  members: {
    id: string;
    name: string;
    order: number;
    status: CampaignStatus;
    wrs?: number;
    level?: WrsBreakdown['level'];
    verdict?: 'PASS' | 'FAIL';
    runId?: string;
  }[];
  wrs: { avg: number; min: number; level: WrsBreakdown['level']; scored: number } | null;
  verdict: 'PASS' | 'FAIL' | null;
}

export interface ManagedUser {
  isOwner?: boolean;
  email: string;
  role: Role;
  source: 'env' | 'store';
  status?: 'active' | 'disabled';
  mustChangePassword?: boolean;
  createdAt?: string;
  lastLoginAt?: string;
}

export interface FleetMissionStatus {
  enabled: boolean;
  target: string;
  caps: { maxRps: number; maxConcurrency: number; maxDurationSec: number };
  missions: {
    id: string;
    createdAt: string;
    maxRps: number;
    durationSec: number;
    snapshot: {
      state: string;
      shards: {
        agentId: string;
        state: string;
        progress?: { sent: number; successful: number; failed: number };
        result?: {
          reason?: string;
          generator?: { totalRequests: number; successful: number; failed: number };
        };
      }[];
    } | null;
  }[];
}
export interface FleetCampaignObservation {
  campaignId: string;
  mission:
    | (FleetMissionStatus['missions'][number] & {
        target: string;
        agentSites?: Record<string, string>;
      })
    | null;
}
export interface AgentGeneratorMeasurement {
  totalRequests: number;
  successful: number;
  failed: number;
  actualRps?: number;
  latencyMs?: { p95: number };
  errors?: Record<string, number>;
}
export interface FleetOverview {
  inventoryCount?: number;
  origins: string[];
  enabled: boolean;
  observedAt: string;
  group: string;
  caps: { maxRps: number; maxConcurrency: number; maxDurationSec: number };
  devices: (FleetDevice & { missionCapable: boolean; supportedMethods: string[] })[];
  missions: {
    id: string;
    campaignId: string;
    name: string;
    target: string;
    createdAt: string;
    deadline: number;
    deviceIds: string[];
    snapshot: FleetMissionStatus['missions'][number]['snapshot'];
  }[];
}

export interface DrsCatalog {
  version: string;
  reference: string;
  provenance: string;
  scope: string;
  executionCaps: {
    maxAgents: number;
    maxRps: number;
    maxConcurrency: number;
    maxDurationSec: number;
  };
  inventoryCaps: { maxDevices: number; maxSites: number; pageSize: number };
  profiles: {
    id: string;
    name: string;
    level?: number;
    summary: string;
    supported: boolean;
    status: string;
    reason: string;
  }[];
}

export interface DrsReferenceView {
  manifest: { version: string; catalogue_sha256: string; vector_count: number };
  ambiguities: { id: string; review_status: string }[];
}
export interface DrsRevisionView {
  number: number;
  id: string;
  state: string;
  plan: Record<string, unknown>;
  planHash?: string;
  finalizedAt?: string;
  proofs: { id: string; hash: string; provenance: string }[];
  trace: { state: string; at: string; detail: string }[];
  reference: {
    standardVersion: string;
    engineVersion: string;
    catalogueHash: string;
    interpretationProfile: string;
  };
}
export interface DrsCampaignView {
  document: { currentRevision: number; revisions: DrsRevisionView[] } | null;
  defaultPlan: Record<string, unknown>;
}
export interface DrsReportView {
  assessment: {
    label: string;
    status: string;
    score: number | null;
    terminalLevel: number | null;
    terminalOutcome: string;
    reservations: string[];
    levels: {
      level: number;
      total: number;
      passed: number;
      failed: number;
      inconclusive: number;
      excluded: number;
      outcome: string;
    }[];
  };
  reference: DrsRevisionView['reference'];
  revision: number;
}
