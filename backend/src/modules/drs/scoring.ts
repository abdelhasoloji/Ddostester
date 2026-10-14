import { drsReference, digest } from './reference.js';
import type { DrsVector } from './reference.js';
import { ensure, planDigest } from './model.js';
import type { DrsRevision, DrsProof } from './model.js';
export interface DrsConclusion {
  vectorId: string;
  validity: 'VALID' | 'INVALID' | 'INCONCLUSIVE';
  result: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  reasons: string[];
  proofIds: string[];
  excluded: boolean;
}
export interface DrsLevelScore {
  level: number;
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  excluded: number;
  ratio: number;
  score: number;
  lowerBound: number;
  upperBound: number;
  outcome: 'PASS' | 'FAIL' | 'MET' | 'PARTIAL';
  complete: boolean;
}
export interface DrsAssessment {
  mode: string;
  label: string;
  status: 'COMPLETE' | 'PARTIAL' | 'INDETERMINATE';
  score: number | null;
  terminalLevel: number | null;
  terminalOutcome: string;
  levels: DrsLevelScore[];
  conclusions: DrsConclusion[];
  diagnosticVectorIds: string[];
  ambiguities: unknown[];
  proofHash: string;
  certification: false;
  reservations: string[];
}
export function classifyRatio(
  passed: number,
  total: number,
  level: number,
): 'PASS' | 'FAIL' | 'MET' {
  ensure(
    Number.isInteger(passed) &&
      Number.isInteger(total) &&
      total > 0 &&
      passed >= 0 &&
      passed <= total,
    'Invalid counts',
  );
  ensure(Number.isInteger(level) && level >= 1 && level <= 7, 'Invalid level');
  const percent = level <= 3 ? 75 : 85;
  return passed * 100 > total * percent ? 'PASS' : passed * 100 < total * 40 ? 'FAIL' : 'MET';
}
function quantity(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)([KMGTP]?)$/.exec(raw);
  return m
    ? Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[m[2]] ?? NaN)
    : null;
}
function seconds(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|seconds?|minutes?|hours?|days?|months?|years?)$/.exec(raw);
  const unit = m?.[2];
  const scale = unit
    ? (
        {
          s: 1,
          m: 60,
          h: 3600,
          second: 1,
          seconds: 1,
          minute: 60,
          minutes: 60,
          hour: 3600,
          hours: 3600,
          day: 86400,
          days: 86400,
        } as Record<string, number>
      )[unit]
    : undefined;
  return m && scale ? Number(m[1]) * scale : null;
}
export function verifyProofChain(r: DrsRevision): boolean {
  let prev: string | null = null;
  for (const p of r.proofs) {
    if (
      p.previousHash !== prev ||
      p.hash !==
        digest({
          previousHash: prev,
          id: p.id,
          actor: p.actor,
          at: p.at,
          provenance: p.provenance,
          data: p.data,
        })
    )
      return false;
    prev = p.hash;
  }
  return true;
}
export function qualify(v: DrsVector, p: DrsProof, r: DrsRevision): DrsConclusion {
  const e = p.data,
    plan = r.plan;
  const reasons: string[] = [];
  const answer = (
    validity: DrsConclusion['validity'],
    result: DrsConclusion['result'],
  ): DrsConclusion => ({
    vectorId: v.internal_id,
    validity,
    result,
    reasons,
    proofIds: [p.id],
    excluded: false,
  });
  if (e.cancelled) {
    reasons.push('Cancelled without conclusion');
    return answer('INVALID', 'NOT_EVALUATED');
  }
  if ((plan.mode === 'engine-validation') !== (p.provenance === 'simulation')) {
    reasons.push('Evidence provenance does not match campaign mode');
    return answer('INVALID', 'NOT_EVALUATED');
  }
  const isSimulation = plan.mode === 'engine-validation';
  if (!isSimulation && v.ambiguity_ids.length)
    reasons.push('Unresolved source ambiguities: ' + v.ambiguity_ids.join(', '));
  if (
    !isSimulation &&
    e.requested_load.unit === 'tps' &&
    e.requested_load.value > plan.budgets.maxRps
  ) {
    reasons.push('Recorded load exceeds frozen shared budget; not a valid authorized exposure');
    return answer('INVALID', 'NOT_EVALUATED');
  }
  if (!isSimulation && e.physical_generators > plan.budgets.maxAgents) {
    reasons.push('Recorded physical generators exceed frozen agent budget');
    return answer('INVALID', 'NOT_EVALUATED');
  }
  if (
    !isSimulation &&
    (Date.parse(e.startedAt) < Date.parse(r.frozenAt ?? r.createdAt) ||
      Date.parse(e.finishedAt) >
        Date.now() + Math.max(...plan.sources.map((s) => s.clockUncertaintyMs)))
  )
    reasons.push(
      'Evidence timing is outside the frozen plan or ahead of synchronized observation time',
    );
  if (e.telemetry_gaps.length) reasons.push('Telemetry gaps');
  if (e.baselineSeconds < plan.baselineMinSec || !e.baselineStable)
    reasons.push('Baseline missing, too short or unstable');
  const baseline = e.latency_baseline.samplesMs;
  const mean = e.latency_baseline.meanMs ?? 0;
  const dispersion =
    Math.sqrt(baseline.reduce((s, x) => s + (x - mean) ** 2, 0) / baseline.length) / (mean || 1);
  if (dispersion > plan.baselineStabilityTolerance) reasons.push('Baseline distribution unstable');
  const elapsed = (Date.parse(e.finishedAt) - Date.parse(e.startedAt)) / 1000;
  if (elapsed < plan.exposureSec) reasons.push('Exposure below frozen plan duration');
  if (e.injection_point !== plan.architecture.injectionPoint)
    reasons.push('Injection point does not match frozen plan');
  const inScope = plan.services.filter((s) => !s.outOfScopeReason);
  for (const s of inScope)
    if (
      !e.serviceIds.includes(s.id) ||
      !e.legitimate_transaction_success.some(
        (x) => x.serviceId === s.id && x.total > 0 && x.assertionEvaluated,
      )
    )
      reasons.push('Missing functional evidence for ' + s.id);
  for (const s of inScope) {
    const b = e.baseline_transaction_success.find((x) => x.serviceId === s.id);
    if (
      !b ||
      !b.assertionEvaluated ||
      !b.assertionVerified ||
      b.total <= 0 ||
      b.successful / b.total < s.successThreshold
    )
      reasons.push('Service not healthy at baseline: ' + s.id);
  }
  const frequency = plan.sources.find((s) => s.role === 'user')!.frequencyMs;
  if (e.latency_baseline.samplesMs.length < Math.ceil((plan.baselineMinSec * 1000) / frequency))
    reasons.push('Baseline distribution coverage insufficient');
  if (e.latency_during_test.samplesMs.length < Math.ceil((elapsed * 1000) / frequency))
    reasons.push('Under-load latency distribution coverage insufficient');
  const sources = plan.sources;
  for (const role of ['generator', 'entry', 'user', 'origin']) {
    const pts = e.points.filter((p) => sources.find((s) => s.id === p.sourceId)?.role === role);
    if (pts.length === 0) reasons.push('Missing ' + role + ' instrumentation');
    for (const point of pts) {
      const source = sources.find((s) => s.id === point.sourceId)!;
      if (
        Date.parse(point.startedAt) > Date.parse(e.startedAt) + source.clockUncertaintyMs ||
        Date.parse(point.finishedAt) < Date.parse(e.finishedAt) - source.clockUncertaintyMs
      )
        reasons.push('Incomplete ' + role + ' observation window');
      if (point.sampleCount < Math.ceil((elapsed * 1000) / source.frequencyMs))
        reasons.push('Insufficient ' + role + ' samples');
      if (point.saturated) reasons.push(role + ' instrumentation saturated');
    }
  }
  const loadEntries = Object.entries(v.load_requirements);
  for (const [name, raw] of loadEntries) {
    const unit = name.slice(4);
    const needed = quantity(raw);
    if (needed === null) {
      reasons.push('Uninterpreted load unit or value');
      continue;
    }
    if (e.requested_load.unit !== unit || e.requested_load.value < needed)
      reasons.push('Requested load below standard line');
    for (const role of ['generator', 'entry']) {
      const matching = e.points.filter(
        (p) => sources.find((s) => s.id === p.sourceId)?.role === role && p.load?.unit === unit,
      );
      if (
        !matching.length ||
        (role === 'entry'
          ? Math.max(...matching.map((p) => p.load?.value ?? 0))
          : matching.reduce((s, p) => s + (p.load?.value ?? 0), 0)) < needed
      )
        reasons.push(role + ' load below standard line');
    }
  }
  if (!loadEntries.length) reasons.push('Standard line has no unambiguous load requirement');
  for (const key of v.required_properties)
    if (!e.observed_properties.includes(key)) reasons.push('Unproven property ' + key);
  if (e.unrepresented_dimensions.length) reasons.push('Unrepresented dimensions');
  if (e.calibration_evidence.length === 0) reasons.push('Calibration evidence missing');
  if (!e.jointExposureId) reasons.push('Combined exposure not established');
  const bots = quantity(v.service_requirements.max_bots);
  if (
    !isSimulation &&
    (bots === null ||
      e.physical_generators < bots ||
      new Set(e.observed_source_addresses).size < bots)
  )
    reasons.push(
      'Physical source diversity not established; virtual clients are not independent bots',
    );
  const persistence = seconds(v.service_requirements.persistence);
  if (!isSimulation && (persistence === null || elapsed < persistence))
    reasons.push('Persistence dimension not established');
  if (!e.recovery_timestamp) reasons.push('Recovery not observed');
  const recovery = e.recovery_timestamp
    ? Date.parse(e.recovery_timestamp) - Date.parse(e.finishedAt)
    : 0;
  if (recovery < 0 || recovery > plan.recoveryTimeoutSec * 1000)
    reasons.push('Recovery observation outside frozen window');
  if (reasons.length) return answer('INCONCLUSIVE', 'NOT_EVALUATED');
  const maxOut = seconds(v.service_requirements.max_out),
    maxLatency = seconds(v.service_requirements.max_latency);
  if (maxOut === null || maxLatency === null) {
    reasons.push('Service thresholds cannot be interpreted');
    return answer('INCONCLUSIVE', 'NOT_EVALUATED');
  }
  const intervals = [...e.outage_intervals].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  );
  let outage = 0,
    end = 0;
  for (const x of intervals) {
    const a = Date.parse(x.start),
      b = Date.parse(x.end);
    outage += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  const fails =
    inScope.some((s) => {
      const m = e.legitimate_transaction_success.find((x) => x.serviceId === s.id)!;
      return !m.assertionVerified || m.successful / m.total < s.successThreshold;
    }) ||
    outage > maxOut * 1000 ||
    (e.latency_during_test.meanMs ?? 0) - (e.latency_baseline.meanMs ?? 0) > maxLatency * 1000;
  if (fails) reasons.push('Functional service, outage or extra latency threshold breached');
  return answer('VALID', fails ? 'FAIL' : 'PASS');
}
/** Conservative aggregation preserves historical failures and never drops unknown vectors. */
export function assessDrs(r: DrsRevision): DrsAssessment {
  ensure(r.planHash === planDigest(r), 'Frozen plan integrity mismatch');
  ensure(verifyProofChain(r), 'Evidence archive integrity mismatch');
  const ref = drsReference();
  ensure(
    r.reference.catalogueHash === ref.manifest.catalogue_sha256,
    'Unsupported archived reference',
  );
  const vectors = ref.vectors.filter((v) => v.level <= r.plan.maxLevel);
  const conclusions: DrsConclusion[] = vectors.map((v) => {
    const excluded = r.plan.excludedVectors.some((e) => e.vectorId === v.internal_id);
    const attempts = r.proofs
      .filter((p) => p.data.vectorId === v.internal_id)
      .map((p) => qualify(v, p, r));
    const failed = attempts.find((a) => a.validity === 'VALID' && a.result === 'FAIL');
    const passed = attempts.find((a) => a.validity === 'VALID' && a.result === 'PASS');
    const outcome = failed ??
      passed ??
      attempts[attempts.length - 1] ?? {
        vectorId: v.internal_id,
        validity: 'INCONCLUSIVE' as const,
        result: 'NOT_EVALUATED' as const,
        reasons: ['Scenario missing'],
        proofIds: [],
        excluded: false,
      };
    if (excluded)
      return {
        vectorId: v.internal_id,
        validity: 'INCONCLUSIVE',
        result: 'NOT_EVALUATED',
        reasons: [
          'Excluded diagnostically: ' +
            r.plan.excludedVectors.find((e) => e.vectorId === v.internal_id)!.reason,
        ],
        proofIds: outcome.proofIds,
        excluded: true,
      };
    return { ...outcome, proofIds: attempts.flatMap((a) => a.proofIds) };
  });
  const levels: DrsLevelScore[] = [];
  let terminalLevel: number | null = null,
    score: number | null = null,
    terminalOutcome = 'INDETERMINATE';
  let stopped = false;
  let lastPassed: number | null = null;
  for (let level = 1; level <= r.plan.maxLevel; level++) {
    const c = conclusions.filter(
      (x) => vectors.find((v) => v.internal_id === x.vectorId)?.level === level,
    );
    const passed = c.filter((x) => x.result === 'PASS' && x.validity === 'VALID').length,
      failed = c.filter((x) => x.result === 'FAIL' && x.validity === 'VALID').length;
    const inconclusive = c.length - passed - failed,
      ratio = passed / c.length,
      calculated = level - 1 + ratio,
      complete = inconclusive === 0 && !r.plan.services.some((s) => s.outOfScopeReason);
    const chosen = c
      .map((x) =>
        r.proofs.find(
          (p) =>
            p.id ===
            x.proofIds.find((id) => {
              const p = r.proofs.find((p) => p.id === id);
              return (
                p &&
                qualify(
                  vectors.find((v) => v.internal_id === x.vectorId)!,
                  p,
                  r,
                ).result === x.result
              );
            }),
        ),
      )
      .filter((p) => p !== undefined);
    const jointComplete =
      chosen.length === c.length &&
      new Set(chosen.map((p) => p!.data.jointExposureId)).size === 1 &&
      Math.min(...chosen.map((p) => Date.parse(p!.data.finishedAt))) -
        Math.max(...chosen.map((p) => Date.parse(p!.data.startedAt))) >=
        r.plan.exposureSec * 1000;
    const fullyComplete = complete && jointComplete;
    const outcome = fullyComplete ? classifyRatio(passed, c.length, level) : 'PARTIAL';
    levels.push({
      level,
      total: c.length,
      passed,
      failed,
      inconclusive,
      excluded: c.filter((x) => x.excluded).length,
      ratio,
      score: calculated,
      lowerBound: calculated,
      upperBound: level - 1 + (passed + inconclusive) / c.length,
      outcome,
      complete: fullyComplete,
    });
    if (!stopped) {
      terminalLevel = level;
      terminalOutcome = outcome;
      if (outcome === 'PASS') {
        lastPassed = calculated;
        score = calculated;
      } else {
        score = outcome === 'MET' ? calculated : outcome === 'FAIL' ? lastPassed : null;
        stopped = true;
      }
    }
  }
  const status =
    terminalOutcome === 'PARTIAL'
      ? r.proofs.length || r.attachments?.length
        ? 'PARTIAL'
        : 'INDETERMINATE'
      : 'COMPLETE';
  const relevantIds = new Set(vectors.flatMap((v) => v.ambiguity_ids));
  const ambiguities = ref.ambiguities.filter((a) => !a.vector_id || relevantIds.has(a.id));
  return {
    mode: r.plan.mode,
    label:
      r.plan.mode === 'engine-validation'
        ? 'Simulation score — no resilience measurement'
        : r.plan.mode === 'synthetic-lab'
          ? 'Experimental score — laboratory dimensions only'
          : 'Measured DRS assessment — evidence and interpretation reservations apply',
    status,
    score,
    terminalLevel,
    terminalOutcome,
    levels,
    conclusions,
    diagnosticVectorIds: conclusions
      .filter(
        (c) =>
          (vectors.find((v) => v.internal_id === c.vectorId)?.level ?? 0) > (terminalLevel ?? 0) &&
          c.proofIds.length,
      )
      .map((c) => c.vectorId),
    ambiguities,
    proofHash: digest(r.proofs),
    certification: false,
    reservations: [
      'Not a Red Button certification',
      'Imported evidence retains collector provenance; structural validation is not physical attestation',
      'WRS is a separate diagnostic and is never averaged into DRS',
      ...(r.plan.mode === 'engine-validation'
        ? ['All events are simulated; score has no measured resilience value']
        : []),
      ...(r.plan.services.some((s) => s.outOfScopeReason)
        ? ['Services excluded from scope; coverage is partial']
        : []),
    ],
  };
}
