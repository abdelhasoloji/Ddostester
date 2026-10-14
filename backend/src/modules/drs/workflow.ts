import { getBuildInfo } from '../../version.js';
import { randomUUID } from 'node:crypto';
import type { Campaign } from '../campaigns/model.js';
import { FLEET_LIMITS, DRS_EVIDENCE_LIMITS } from '../../config/limits.js';
import { digest, drsReference } from './reference.js';
import {
  DrsError,
  ensure,
  referenceSnapshot,
  validatePlan,
  validateEvidence,
  planDigest,
  latency,
} from './model.js';
import type { DrsDocument, DrsRevision, DrsPlan, DrsState, DrsEvidence, DrsMode } from './model.js';
import { assessDrs } from './scoring.js';
export function defaultPlan(c: Campaign, mode: DrsMode = c.drsMode ?? 'synthetic-lab'): DrsPlan {
  return {
    mode,
    maxLevel: 1,
    services: [
      {
        id: 'service-1',
        url: c.target,
        protocol: 'HTTP',
        journey: 'GET ' + c.probeUrl,
        functionalAssertion:
          'Configure a functional response assertion; HTTP status alone is insufficient',
        successThreshold: 1,
      },
    ],
    architecture: {
      entryPoint: c.target,
      protection: 'Not recorded',
      origin: 'Not recorded',
      injectionPoint: c.target,
    },
    sources: ['generator', 'entry', 'user', 'origin'].map((role) => ({
      id: role,
      role: role as DrsPlan['sources'][number]['role'],
      resourceId:
        role === 'generator'
          ? 'fleet'
          : role === 'user'
            ? 'independent-probe'
            : 'unconfigured-' + role,
      connectionPoolId: role + '-pool',
      position:
        role === 'generator'
          ? 'Fleet lab'
          : role === 'user'
            ? 'Control plane probe'
            : 'Unconfigured',
      frequencyMs: 1000,
      clockUncertaintyMs: 100,
    })),
    baselineMinSec: 300,
    baselineStabilityTolerance: 0.1,
    exposureSec: c.maxDurationSec,
    exposureRationale: 'Bounded laboratory exposure; cannot establish full standard persistence',
    recoveryTimeoutSec: 300,
    budgets: {
      maxRps: c.maxRps,
      concurrency: c.concurrency,
      maxAgents: Math.min(c.fleetDeviceIds?.length ?? 1, FLEET_LIMITS.maxAgents),
      maxDurationSec: c.maxDurationSec,
    },
    stopConditions: ['Campaign kill switch', 'Frozen budget exceeded', 'Probe unhealthy'],
    protectionConfiguration: 'Not recorded',
    componentVersions: {
      controlPlane: JSON.stringify(getBuildInfo()),
      generator: c.agent ?? 'builtin',
    },
    excludedVectors: [],
    latencyRule: 'mean-extra-roundtrip-ms',
  };
}
export function createRevision(
  doc: DrsDocument | undefined,
  plan: DrsPlan,
  actor: string,
): DrsDocument {
  ensure(!doc || doc.revisions.length < DRS_EVIDENCE_LIMITS.maxRevisions, 'Revision limit reached');
  const number = (doc?.currentRevision ?? 0) + 1;
  const at = new Date().toISOString();
  const r: DrsRevision = {
    number,
    id: randomUUID(),
    createdAt: at,
    createdBy: actor,
    reference: referenceSnapshot(),
    plan: validatePlan(plan),
    state: 'DRAFT',
    trace: [
      {
        state: 'DRAFT',
        at,
        detail: 'New immutable revision; previous evidence and failures preserved',
      },
    ],
    proofs: [],
  };
  return { currentRevision: number, revisions: [...(doc?.revisions ?? []), r] };
}
export function currentRevision(doc: DrsDocument | undefined): DrsRevision {
  ensure(doc, 'DRS plan not configured');
  const r = doc.revisions.find((r) => r.number === doc.currentRevision);
  ensure(r, 'Current revision missing');
  return r;
}
export function transition(r: DrsRevision, state: DrsState, detail: string) {
  r.state = state;
  r.trace.push({ state, at: new Date().toISOString(), detail });
}
export function freeze(r: DrsRevision, c: Campaign) {
  ensure(r.state === 'DRAFT', 'Only a draft revision can be frozen');
  const b = r.plan.budgets;
  ensure(
    b.maxRps <= Math.min(c.maxRps, FLEET_LIMITS.maxRps) &&
      b.concurrency <= Math.min(c.concurrency, FLEET_LIMITS.maxConcurrency) &&
      b.maxAgents <= FLEET_LIMITS.maxAgents &&
      b.maxDurationSec <= Math.min(c.maxDurationSec, FLEET_LIMITS.maxDurationSec),
    'Frozen execution budget exceeds campaign or Fleet limits',
  );
  ensure(r.plan.exposureSec <= b.maxDurationSec, 'Exposure exceeds frozen duration ceiling');
  if (r.plan.mode !== 'engine-validation')
    ensure(c.authorized === true, 'Physical assessment requires an attested authorized campaign');
  const scopeHosts = [c.target, c.probeUrl, c.referenceUrl]
    .filter((url): url is string => !!url)
    .map((url) => new URL(url).hostname);
  for (const s of r.plan.services) {
    let url: URL;
    try {
      url = new URL(s.url);
    } catch {
      throw new DrsError('Invalid service URI');
    }
    ensure(!url.username && !url.password, 'Embedded service credentials are forbidden');
    ensure(
      scopeHosts.includes(url.hostname) && url.hostname.length > 0,
      'Services must belong to authorized campaign hosts; no scope expansion',
    );
  }
  r.planHash = planDigest(r);
  r.frozenAt = new Date().toISOString();
  transition(
    r,
    'PLAN_FROZEN',
    'Standard, catalogue, engine, scope, interpretation and budgets frozen',
  );
}
export function capacity(r: DrsRevision) {
  ensure(r.planHash === planDigest(r) && !r.finalizedAt, 'Frozen active plan required');
  transition(
    r,
    'CAPACITY_CHECK',
    r.plan.mode === 'engine-validation'
      ? 'Virtual capacity verification; no physical generator'
      : 'Independent collector capacity and calibration evidence required; no automatic traffic dispatch',
  );
  return {
    physicalExecutionReady: false,
    simulationReady: r.plan.mode === 'engine-validation',
    missing:
      r.plan.mode === 'engine-validation'
        ? []
        : [
            'Entry/origin collectors and functional probe evidence',
            'Physical source and persistence qualification',
            'Per-scenario generator capability; unsupported vectors remain disabled',
          ],
  };
}
export function appendProof(
  r: DrsRevision,
  raw: DrsEvidence,
  actor: string,
  provenance: 'simulation' | 'collector-import' | 'run-adapter',
) {
  ensure(r.planHash === planDigest(r) && !r.finalizedAt, 'Frozen active revision required');
  ensure(r.proofs.length < DRS_EVIDENCE_LIMITS.maxAttempts, 'Evidence archive limit reached');
  ensure(
    r.plan.mode === 'engine-validation' ? provenance === 'simulation' : provenance !== 'simulation',
    'Simulation cannot become measured evidence',
  );
  const data = validateEvidence(raw, r.plan);
  ensure(
    drsReference().vectors.find((v) => v.internal_id === data.vectorId)!.level <= r.plan.maxLevel,
    'Evidence outside planned levels',
  );
  ensure(
    !r.proofs.some((p) => p.data.attemptId === data.attemptId),
    'Attempt already archived; retry requires a new attempt ID',
  );
  const id = randomUUID(),
    at = new Date().toISOString(),
    previousHash = r.proofs.at(-1)?.hash ?? null;
  r.proofs.push({
    id,
    at,
    actor,
    previousHash,
    provenance,
    data,
    hash: digest({ previousHash, id, at, actor, provenance, data }),
  });
  transition(r, 'BASELINE', 'Archived baseline and health evidence');
  transition(
    r,
    'LEVEL_EXECUTION',
    'Archived requested/emitted/received exposure; actual dispatch is external to evidence engine',
  );
  transition(r, 'RECOVERY', 'Archived post-injection recovery observations');
  transition(r, 'EVIDENCE_VALIDATION', 'Evidence qualified independently from generator outcome');
  transition(
    r,
    'LEVEL_CALCULATION',
    'Reproducible scoring; incomplete evidence does not count as PASS',
  );
}
export function simulate(
  r: DrsRevision,
  actor: string,
  scenario: 'healthy' | 'generator-saturation' | 'service-outage' | 'telemetry-gap',
) {
  ensure(
    r.plan.mode === 'engine-validation',
    'Only engine-validation mode may generate simulated events',
  );
  capacity(r);
  const base = Date.now();
  const vectors = drsReference().vectors.filter((v) => v.level <= r.plan.maxLevel);
  for (const v of vectors) {
    const unit = Object.keys(v.load_requirements)[0]?.slice(4) as 'bps' | 'pps' | 'tps' | 'cps';
    const raw = Object.values(v.load_requirements)[0] ?? '0';
    const m = /^(\d+(?:\.\d+)?)([KMGTP]?)$/.exec(raw);
    const value = m
      ? Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[m[2]] ?? 1)
      : 0;
    const start = new Date(base).toISOString(),
      end = new Date(base + r.plan.exposureSec * 1000).toISOString();
    const e: DrsEvidence = {
      vectorId: v.internal_id,
      attemptId: 'simulation-' + randomUUID(),
      serviceIds: r.plan.services.filter((s) => !s.outOfScopeReason).map((s) => s.id),
      startedAt: start,
      finishedAt: end,
      requested_load: { value, unit: unit ?? 'tps' },
      points: r.plan.sources.map((s) => ({
        sourceId: s.id,
        startedAt: start,
        finishedAt: end,
        artifactHash: digest({ fixture: scenario, source: s.id, vector: v.internal_id }),
        sampleCount: Math.ceil((r.plan.exposureSec * 1000) / s.frequencyMs),
        ...(s.role === 'generator' || s.role === 'entry'
          ? { load: { value, unit: unit ?? 'tps' } }
          : {}),
        saturated: scenario === 'generator-saturation' && s.role === 'generator',
      })),
      legitimate_transaction_success: r.plan.services
        .filter((s) => !s.outOfScopeReason)
        .map((s) => ({
          serviceId: s.id,
          total: 100,
          successful: scenario === 'service-outage' ? 0 : 100,
          assertionEvaluated: true,
          assertionVerified: true,
        })),
      baseline_transaction_success: r.plan.services
        .filter((s) => !s.outOfScopeReason)
        .map((s) => ({
          serviceId: s.id,
          total: 300,
          successful: 300,
          assertionEvaluated: true,
          assertionVerified: true,
        })),
      latency_baseline: latency(
        Array(
          Math.min(
            2048,
            Math.ceil(
              (r.plan.baselineMinSec * 1000) /
                (r.plan.sources.find((s) => s.role === 'user')?.frequencyMs ?? 1000),
            ),
          ),
        ).fill(10),
      ),
      latency_during_test: latency(
        Array(
          Math.max(
            1,
            Math.ceil(
              (r.plan.exposureSec * 1000) /
                (r.plan.sources.find((s) => s.role === 'user')?.frequencyMs ?? 1000),
            ),
          ),
        ).fill(10),
      ),
      baselineSeconds: r.plan.baselineMinSec,
      baselineStable: true,
      detection_timestamp: start,
      mitigation_timestamp: start,
      outage_intervals: [],
      recovery_timestamp: end,
      manual_interventions: [],
      telemetry_gaps: scenario === 'telemetry-gap' ? ['Simulated independent probe gap'] : [],
      injection_point: r.plan.architecture.injectionPoint,
      physical_generators: 0,
      virtual_clients: 1,
      observed_source_addresses: [],
      emulated_dimensions: ['All scenario measurements are virtual events; no network traffic'],
      unrepresented_dimensions: [],
      calibration_evidence: ['Simulation fixture, not a physical calibration'],
      observed_properties: v.required_properties,
      jointExposureId: 'simulated-combined-' + v.level,
      cancelled: false,
    };
    appendProof(r, e, actor, 'simulation');
  }
  return assessDrs(r);
}
export function finalize(r: DrsRevision) {
  ensure(r.planHash === planDigest(r) && !r.finalizedAt, 'Frozen active revision required');
  transition(r, 'EVIDENCE_VALIDATION', 'Final archive integrity and coverage validation');
  transition(r, 'LEVEL_CALCULATION', 'Terminal level and diagnostic attempts calculated');
  const result = assessDrs(r);
  r.finalizedAt = new Date().toISOString();
  transition(
    r,
    'FINAL_REPORT',
    'Always produce a report, including partial or indeterminate outcomes',
  );
  return result;
}
