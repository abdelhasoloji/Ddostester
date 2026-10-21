import { DRS_EVIDENCE_LIMITS } from '../../config/limits.js';
import { drsBaselineFloorSec } from '../../config/drs-baseline.js';
import { digest, drsReference, DRS_ENGINE, DRS_INTERPRETATION } from './reference.js';
export type DrsMode = 'engine-validation' | 'synthetic-lab' | 'measured';
export type DrsState =
  | 'DRAFT'
  | 'PLAN_FROZEN'
  | 'CAPACITY_CHECK'
  | 'BASELINE'
  | 'LEVEL_EXECUTION'
  | 'RECOVERY'
  | 'EVIDENCE_VALIDATION'
  | 'LEVEL_CALCULATION'
  | 'FINAL_REPORT'
  | 'ENGINE_VALIDATED';
export type DrsRole = 'generator' | 'entry' | 'user' | 'origin';
export interface DrsSource {
  id: string;
  role: DrsRole;
  resourceId: string;
  connectionPoolId: string;
  position: string;
  frequencyMs: number;
  clockUncertaintyMs: number;
}
export interface DrsService {
  id: string;
  url: string;
  protocol: string;
  journey: string;
  functionalAssertion: string;
  successThreshold: number;
  outOfScopeReason?: string;
}
export interface DrsPlan {
  mode: DrsMode;
  maxLevel: number;
  services: DrsService[];
  architecture: { entryPoint: string; protection: string; origin: string; injectionPoint: string };
  sources: DrsSource[];
  baselineMinSec: number;
  baselineStabilityTolerance: number;
  exposureSec: number;
  exposureRationale: string;
  recoveryTimeoutSec: number;
  /**
   * Independent telemetry the client provides for this campaign: an edge counter and/or a
   * target-side counter. They belong to the plan, not to the deployment, because two clients
   * cannot share one endpoint.
   */
  witness?: { entryUrl?: string; originUrl?: string };
  budgets: { maxRps: number; concurrency: number; maxAgents: number; maxDurationSec: number };
  /** Envelope the budgets were derived from, recorded so the report can state it. */
  capacity?: {
    maxRps: number;
    maxConcurrency: number;
    agents: number;
    limitedBy: { rps: string; concurrency: string };
    warnings: string[];
    assessedAt: string;
  };
  stopConditions: string[];
  protectionConfiguration: string;
  componentVersions: Record<string, string>;
  excludedVectors: { vectorId: string; reason: string }[];
  latencyRule: 'mean-extra-roundtrip-ms';
}
export interface DrsReferenceSnapshot {
  standardVersion: string;
  catalogueHash: string;
  engineVersion: string;
  interpretationProfile: string;
}
export interface DrsPoint {
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  artifactHash: string;
  sampleCount: number;
  load?: { value: number; unit: 'bps' | 'pps' | 'tps' | 'cps' };
  saturated?: boolean;
}
export interface DrsLatency {
  samplesMs: number[];
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}
export interface DrsEvidence {
  vectorId: string;
  attemptId: string;
  serviceIds: string[];
  startedAt: string;
  finishedAt: string;
  requested_load: { value: number; unit: 'bps' | 'pps' | 'tps' | 'cps' };
  points: DrsPoint[];
  legitimate_transaction_success: {
    serviceId: string;
    successful: number;
    total: number;
    assertionEvaluated: boolean;
    assertionVerified: boolean;
  }[];
  baseline_transaction_success: {
    serviceId: string;
    successful: number;
    total: number;
    assertionEvaluated: boolean;
    assertionVerified: boolean;
  }[];
  latency_baseline: DrsLatency;
  latency_during_test: DrsLatency;
  baselineSeconds: number;
  baselineStable: boolean;
  detection_timestamp: string | null;
  mitigation_timestamp: string | null;
  outage_intervals: { start: string; end: string }[];
  recovery_timestamp: string | null;
  manual_interventions: string[];
  telemetry_gaps: string[];
  injection_point: string;
  physical_generators: number;
  virtual_clients: number;
  observed_source_addresses: string[];
  emulated_dimensions: string[];
  unrepresented_dimensions: string[];
  calibration_evidence: string[];
  observed_properties: string[];
  jointExposureId: string | null;
  cancelled: boolean;
}
export interface DrsProof {
  id: string;
  actor: string;
  at: string;
  hash: string;
  previousHash: string | null;
  provenance: 'simulation' | 'collector-import' | 'run-adapter';
  data: DrsEvidence;
}
export interface DrsRevision {
  baselineDiagnostic?: import('./baseline.js').DrsBaselineDiagnostic;
  attachments?: import('./attachments.js').DrsAttachment[];
  number: number;
  id: string;
  createdAt: string;
  createdBy: string;
  reference: DrsReferenceSnapshot;
  plan: DrsPlan;
  planHash?: string;
  frozenAt?: string;
  state: DrsState;
  /** Present on a synthetic amplifier run: what it claimed, what it produced, no verdict. */
  synthetic?: import('./synthetic.js').DrsSyntheticValidation;
  trace: { state: DrsState; at: string; detail: string }[];
  proofs: DrsProof[];
  finalizedAt?: string;
}
export interface DrsDocument {
  currentRevision: number;
  revisions: DrsRevision[];
}
export class DrsError extends Error {}
export function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new DrsError(message);
}
export function validText(value: unknown, name: string): asserts value is string {
  ensure(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= DRS_EVIDENCE_LIMITS.maxText,
    name + ' must be a bounded nonempty string',
  );
}
export function referenceSnapshot(): DrsReferenceSnapshot {
  const { manifest } = drsReference();
  return {
    standardVersion: manifest.version,
    catalogueHash: manifest.catalogue_sha256,
    engineVersion: DRS_ENGINE,
    interpretationProfile: DRS_INTERPRETATION,
  };
}
export function latency(samplesMs: number[]): DrsLatency {
  ensure(
    samplesMs.length <= DRS_EVIDENCE_LIMITS.maxSamples &&
      samplesMs.every((x) => Number.isFinite(x) && x >= 0),
    'Invalid latency samples',
  );
  if (samplesMs.length === 0)
    return { samplesMs: [], meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
  const a = [...samplesMs].sort((x, y) => x - y);
  const p = (n: number) => a[Math.max(0, Math.ceil(a.length * n) - 1)];
  return {
    samplesMs: [...samplesMs],
    meanMs: a.reduce((s, x) => s + x, 0) / a.length,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    p99Ms: p(0.99),
  };
}
export function validatePlan(raw: DrsPlan): DrsPlan {
  ensure(raw && typeof raw === 'object', 'Plan required');
  const p = structuredClone(raw);
  ensure(
    ['engine-validation', 'synthetic-lab', 'measured'].includes(p.mode),
    'Unknown campaign mode',
  );
  ensure(Number.isInteger(p.maxLevel) && p.maxLevel >= 1 && p.maxLevel <= 7, 'Level must be 1–7');
  if (p.witness) {
    const check = (url: string | undefined, field: string) => {
      if (url === undefined || url === '') return;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new DrsError(`${field} must be an absolute URL`);
      }
      ensure(
        parsed.protocol === 'http:' || parsed.protocol === 'https:',
        `${field} must be http(s)`,
      );
      ensure(!parsed.username && !parsed.password, `${field} must not carry credentials`);
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      const privateV4 =
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
      // A witness is fetched by the server: never let a plan point it at infrastructure the
      // caller could not otherwise reach.
      ensure(
        !(loopback || privateV4) || process.env.DRS_ALLOW_PRIVATE_WITNESS === '1',
        `${field} points at a private address; set DRS_ALLOW_PRIVATE_WITNESS=1 to allow it`,
      );
    };
    check(p.witness.entryUrl, 'witness.entryUrl');
    check(p.witness.originUrl, 'witness.originUrl');
  }

  ensure(
    Array.isArray(p.services) &&
      p.services.length > 0 &&
      p.services.length <= DRS_EVIDENCE_LIMITS.maxServices,
    'Services required',
  );
  ensure(
    new Set(p.services.map((s) => s.id)).size === p.services.length,
    'Service IDs must be unique',
  );
  for (const s of p.services) {
    for (const k of ['id', 'url', 'protocol', 'journey', 'functionalAssertion'] as const)
      validText(s[k], k);
    ensure(
      Number.isFinite(s.successThreshold) && s.successThreshold > 0 && s.successThreshold <= 1,
      'Functional success threshold must be (0,1]',
    );
  }
  ensure(
    p.services.some((s) => !s.outOfScopeReason),
    'At least one service must be in scope',
  );
  for (const k of ['entryPoint', 'protection', 'origin', 'injectionPoint'] as const)
    validText(p.architecture?.[k], k);
  ensure(
    Array.isArray(p.sources) &&
      p.sources.length >= 4 &&
      p.sources.length <= DRS_EVIDENCE_LIMITS.maxSources,
    'Four instrumentation roles are required',
  );
  ensure(
    new Set(p.sources.map((s) => s.id)).size === p.sources.length,
    'Source IDs must be unique',
  );
  for (const s of p.sources) {
    for (const k of ['id', 'resourceId', 'connectionPoolId', 'position'] as const)
      validText(s[k], k);
    ensure(['generator', 'entry', 'user', 'origin'].includes(s.role), 'Unknown source role');
    ensure(
      Number.isFinite(s.frequencyMs) && s.frequencyMs > 0 && s.frequencyMs <= 60000,
      'Invalid measurement frequency',
    );
    ensure(
      Number.isFinite(s.clockUncertaintyMs) &&
        s.clockUncertaintyMs >= 0 &&
        s.clockUncertaintyMs <= s.frequencyMs,
      'Clock uncertainty exceeds sample interval',
    );
  }
  for (const role of ['generator', 'entry', 'user', 'origin'])
    ensure(
      p.sources.some((s) => s.role === role),
      'Missing instrumentation role ' + role,
    );
  for (const g of p.sources.filter((s) => s.role === 'generator'))
    for (const u of p.sources.filter((s) => s.role === 'user'))
      ensure(
        g.resourceId !== u.resourceId && g.connectionPoolId !== u.connectionPoolId,
        'User probes must use independent resources and connections',
      );
  ensure(
    Number.isFinite(p.baselineMinSec) &&
      p.baselineMinSec >= drsBaselineFloorSec() &&
      p.baselineMinSec <= DRS_EVIDENCE_LIMITS.baselineMaxSec,
    'Baseline is below the configured floor or above the observation limit',
  );
  ensure(
    Number.isFinite(p.baselineStabilityTolerance) &&
      p.baselineStabilityTolerance >= 0 &&
      p.baselineStabilityTolerance <= 1,
    'Invalid baseline tolerance',
  );
  ensure(
    Number.isFinite(p.exposureSec) &&
      p.exposureSec > 0 &&
      Number.isFinite(p.recoveryTimeoutSec) &&
      p.recoveryTimeoutSec > 0 &&
      p.recoveryTimeoutSec <= DRS_EVIDENCE_LIMITS.maxObservationSec,
    'Exposure and recovery windows required',
  );
  validText(p.exposureRationale, 'Exposure rationale');
  validText(p.protectionConfiguration, 'Protection configuration');
  ensure(p.latencyRule === 'mean-extra-roundtrip-ms', 'Unsupported latency interpretation');
  ensure(
    p.componentVersions &&
      typeof p.componentVersions === 'object' &&
      Object.keys(p.componentVersions).length > 0,
    'Component versions required',
  );
  ensure(Object.keys(p.componentVersions).length <= 64, 'Too many component versions');
  for (const [key, value] of Object.entries(p.componentVersions)) {
    validText(key, 'Component name');
    validText(value, 'Component version');
  }

  ensure(
    Array.isArray(p.stopConditions) && p.stopConditions.length > 0,
    'Stop conditions required',
  );
  for (const x of p.stopConditions) validText(x, 'Stop condition');
  ensure(
    p.budgets && Object.values(p.budgets).every((x) => Number.isFinite(x) && x > 0),
    'Positive execution budgets required',
  );
  ensure(Array.isArray(p.excludedVectors), 'Explicit exclusions required');
  const ids = new Set(drsReference().vectors.map((v) => v.internal_id));
  for (const x of p.excludedVectors) {
    ensure(ids.has(x.vectorId), 'Unknown excluded vector');
    validText(x.reason, 'Exclusion reason');
  }
  return p;
}
export function planDigest(r: DrsRevision) {
  return digest({ reference: r.reference, plan: r.plan });
}
export function validateEvidence(raw: DrsEvidence, plan: DrsPlan): DrsEvidence {
  ensure(raw && typeof raw === 'object', 'Evidence required');
  const e = structuredClone(raw);
  validText(e.vectorId, 'Vector');
  validText(e.attemptId, 'Attempt');
  ensure(
    drsReference().vectors.some((v) => v.internal_id === e.vectorId),
    'Unknown standard vector',
  );
  const time = (s: string) => Number.isFinite(Date.parse(s));
  ensure(
    time(e.startedAt) && time(e.finishedAt) && Date.parse(e.finishedAt) > Date.parse(e.startedAt),
    'Invalid evidence window',
  );
  ensure(
    Array.isArray(e.points) && e.points.length <= DRS_EVIDENCE_LIMITS.maxSources,
    'Invalid measurement points',
  );
  ensure(
    new Set(e.points.map((p) => p.sourceId)).size === e.points.length,
    'Duplicate source point',
  );
  for (const p of e.points) {
    ensure(
      plan.sources.some((s) => s.id === p.sourceId),
      'Unknown measurement source',
    );
    ensure(
      time(p.startedAt) && time(p.finishedAt) && Date.parse(p.finishedAt) > Date.parse(p.startedAt),
      'Invalid point window',
    );
    ensure(/^[a-f0-9]{64}$/.test(p.artifactHash), 'Artifact SHA256 required');
    ensure(Number.isInteger(p.sampleCount) && p.sampleCount >= 0, 'Invalid sample count');
    if (p.load) validateLoad(p.load);
    if (p.saturated !== undefined)
      ensure(typeof p.saturated === 'boolean', 'Invalid saturation flag');
  }
  validateLoad(e.requested_load);
  ensure(
    Array.isArray(e.serviceIds) &&
      e.serviceIds.length > 0 &&
      e.serviceIds.every((id) => plan.services.some((s) => s.id === id && !s.outOfScopeReason)),
    'Unknown or excluded service',
  );
  ensure(
    Array.isArray(e.legitimate_transaction_success) &&
      new Set(e.legitimate_transaction_success.map((s) => s.serviceId)).size ===
        e.legitimate_transaction_success.length,
    'Duplicate service measurements',
  );
  for (const s of e.legitimate_transaction_success) {
    ensure(
      e.serviceIds.includes(s.serviceId) &&
        Number.isInteger(s.total) &&
        s.total >= 0 &&
        Number.isInteger(s.successful) &&
        s.successful >= 0 &&
        s.successful <= s.total &&
        typeof s.assertionEvaluated === 'boolean' &&
        typeof s.assertionVerified === 'boolean',
      'Invalid functional transactions',
    );
  }
  ensure(
    Array.isArray(e.baseline_transaction_success),
    'Baseline functional measurements required',
  );
  for (const s of e.baseline_transaction_success)
    ensure(
      e.serviceIds.includes(s.serviceId) &&
        Number.isInteger(s.total) &&
        s.total > 0 &&
        Number.isInteger(s.successful) &&
        s.successful >= 0 &&
        s.successful <= s.total &&
        typeof s.assertionEvaluated === 'boolean' &&
        typeof s.assertionVerified === 'boolean',
      'Invalid baseline functional evidence',
    );
  e.latency_baseline = latency(e.latency_baseline?.samplesMs ?? []);
  e.latency_during_test = latency(e.latency_during_test?.samplesMs ?? []);
  ensure(
    Number.isFinite(e.baselineSeconds) &&
      e.baselineSeconds >= 0 &&
      typeof e.baselineStable === 'boolean',
    'Invalid baseline',
  );
  for (const key of [
    'manual_interventions',
    'telemetry_gaps',
    'observed_source_addresses',
    'emulated_dimensions',
    'unrepresented_dimensions',
    'calibration_evidence',
    'observed_properties',
  ] as const) {
    ensure(
      Array.isArray(e[key]) && e[key].length <= DRS_EVIDENCE_LIMITS.maxSamples,
      'Invalid ' + key,
    );
    for (const x of e[key]) validText(x, key);
  }
  for (const key of ['detection_timestamp', 'mitigation_timestamp', 'recovery_timestamp'] as const)
    ensure(e[key] === null || time(e[key]), 'Invalid ' + key);
  ensure(Array.isArray(e.outage_intervals), 'Outage intervals required');
  for (const x of e.outage_intervals)
    ensure(
      time(x.start) &&
        time(x.end) &&
        Date.parse(x.end) >= Date.parse(x.start) &&
        Date.parse(x.start) >= Date.parse(e.startedAt),
      'Invalid outage interval',
    );
  for (const n of [e.physical_generators, e.virtual_clients])
    ensure(Number.isInteger(n) && n >= 0, 'Invalid physical or virtual count');
  validText(e.injection_point, 'Injection point');
  ensure(
    e.jointExposureId === null || typeof e.jointExposureId === 'string',
    'Invalid combined-exposure evidence',
  );
  ensure(typeof e.cancelled === 'boolean', 'Cancelled flag required');
  return e;
}
function validateLoad(x: { value: number; unit: string }) {
  ensure(
    x && Number.isFinite(x.value) && x.value >= 0 && ['bps', 'pps', 'tps', 'cps'].includes(x.unit),
    'Invalid load measurement',
  );
}
