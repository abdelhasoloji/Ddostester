/**
 * DRS ASSESSMENT STATE MACHINE — not a traffic generator.
 *
 * This file sequences a frozen DRS revision (CAPACITY_CHECK → BASELINE →
 * LEVEL_EXECUTION → RECOVERY → EVIDENCE_VALIDATION → LEVEL_CALCULATION). It
 * never opens a socket: capacity, injection and observation all arrive through
 * the `DrsGeneratorPort` / `DrsEvidencePort` adapters implemented by the caller.
 *
 * The synthetic HTTP generator lives in `engine/loadTest.ts` plus the adapters
 * in `agents/`; every rate, concurrency and duration ceiling lives in
 * `config/limits.ts`. Nothing here can raise those ceilings — this file only
 * REJECTS a plan that exceeds them (`ensure(...)`, "Execution envelope exceeds
 * immutable Fleet ceiling").
 *
 * Physical dispatch here is limited to bounded HTTP GET vectors (`…51002`).
 * Every other standard line is reference/import-only, whatever an adapter claims.
 *
 * Wiring: the running control plane drives revisions through the transitions in
 * `workflow.ts` (see `app.runCampaign` and `routes/drs-routes.ts`). No production
 * module imports this orchestrator today; only `test/drs-orchestrator.test.ts`
 * exercises it. It is the complete sequenced path still awaiting bound ports, so
 * treat it as the reference state machine, not as the executed engine.
 */
import { DRS_EVIDENCE_LIMITS, FLEET_LIMITS } from '../../config/limits.js';
import { serviceCeiling } from '../../config/service-ceiling.js';
import { drsReference } from './reference.js';
import { ensure, planDigest } from './model.js';
import type { DrsRevision, DrsEvidence } from './model.js';
import { appendProof, transition, finalize, simulate } from './workflow.js';
import type { DrsAssessment } from './scoring.js';
import { assessDrs } from './scoring.js';
/** A bounded adapter reports capacity, never contributes the resilience verdict. */
export interface DrsGeneratorPort {
  capacity(
    vectorIds: string[],
    budget: DrsRevision['plan']['budgets'],
  ): Promise<{ ready: boolean; reason: string }>;
  start(
    vectorIds: string[],
    budget: DrsRevision['plan']['budgets'],
    signal: AbortSignal,
  ): Promise<{ stop(): Promise<{ confirmed: boolean; stoppedAt: string }> }>;
}
/** Collector must observe entry, user/origin, baseline and recovery independently. */
export interface DrsEvidencePort {
  capacity(plan: DrsRevision['plan']): Promise<{ ready: boolean; reason: string }>;
  baseline(
    plan: DrsRevision['plan'],
    signal: AbortSignal,
  ): Promise<{
    healthy: boolean;
    stable: boolean;
    durationSec: number;
    samples?: number;
    availability?: number;
    coefficientOfVariation?: number | null;
    latency?: { samplesMs: number[]; meanMs: number | null };
  }>;
  observe(vectorIds: string[], plan: DrsRevision['plan'], signal: AbortSignal): Promise<void>;
  recovery(plan: DrsRevision['plan'], signal: AbortSignal): Promise<void>;
  seal(vectorIds: string[], plan: DrsRevision['plan']): Promise<DrsEvidence[]>;
}
/** Injection-free engine validation uses a virtual clock; physical ports are never called. */
export async function orchestrateDrs(
  r: DrsRevision,
  actor: string,
  ports: {
    generator: DrsGeneratorPort;
    collector: DrsEvidencePort;
    signal: AbortSignal;
    checkpoint: (revision: DrsRevision) => Promise<void>;
  },
): Promise<DrsAssessment> {
  ensure(r.planHash === planDigest(r) && !r.finalizedAt, 'Frozen active plan required');
  const b = r.plan.budgets;
  // A frozen plan was already checked against the service ceiling; re-check here so a
  // revision cannot be executed by a caller that bypassed freeze.
  const ceiling = serviceCeiling();
  ensure(
    b.maxRps <= ceiling.maxRps &&
      b.concurrency <= ceiling.maxConcurrency &&
      b.maxAgents <= ceiling.maxAgents &&
      b.maxDurationSec <= ceiling.maxDurationSec,
    'Execution envelope exceeds the service ceiling',
  );
  const save = () => ports.checkpoint(structuredClone(r));
  if (r.plan.mode === 'engine-validation') {
    simulate(r, actor, 'healthy');
    const result = finalize(r);
    await save();
    return result;
  }
  try {
    for (let level = 1; level <= r.plan.maxLevel; level++) {
      if (ports.signal.aborted) throw Error('Assessment cancelled');
      const ids = drsReference()
        .vectors.filter(
          (v) =>
            v.level === level && !r.plan.excludedVectors.some((e) => e.vectorId === v.internal_id),
        )
        .map((v) => v.internal_id);
      transition(
        r,
        'CAPACITY_CHECK',
        'Checking generator and independent collector capacity for level ' + level,
      );
      await save();
      const [g, p] = await bounded(DRS_EVIDENCE_LIMITS.capacityTimeoutMs, ports.signal, () =>
        Promise.all([ports.generator.capacity(ids, b), ports.collector.capacity(r.plan)]),
      );
      if (!g.ready || !p.ready) {
        transition(r, 'CAPACITY_CHECK', 'Capacity not established: ' + g.reason + '; ' + p.reason);
        break;
      }
      transition(
        r,
        'BASELINE',
        'Observe healthy functional service before injection; extend or stop if unstable',
      );
      await save();
      let baseline = await bounded(
        DRS_EVIDENCE_LIMITS.baselineMaxSec * 1000,
        ports.signal,
        (signal) => ports.collector.baseline(r.plan, signal),
      );
      if (
        baseline.healthy &&
        !baseline.stable &&
        baseline.durationSec + r.plan.baselineMinSec <= DRS_EVIDENCE_LIMITS.baselineMaxSec
      ) {
        transition(r, 'BASELINE', 'Extend unstable baseline within bounded observation window');
        await save();
        baseline = await bounded(r.plan.baselineMinSec * 1000 + 2_000, ports.signal, (signal) =>
          ports.collector.baseline(r.plan, signal),
        );
      }
      if (!baseline.healthy || !baseline.stable || baseline.durationSec < r.plan.baselineMinSec) {
        const reason = !baseline.healthy
          ? 'unhealthy'
          : !baseline.stable
            ? 'unstable'
            : 'incomplete';
        // The report has a baseline section; leaving it empty made a rejection unexplainable.
        r.baselineDiagnostic = {
          reason,
          elapsedSec: baseline.durationSec,
          observedDurationSec: baseline.durationSec,
          samples: baseline.samples ?? 0,
          samplesMs: baseline.latency?.samplesMs ?? [],
          availabilityPct: Math.round((baseline.availability ?? 0) * 1000) / 10,
          meanMs: baseline.latency?.meanMs ?? null,
          coefficientOfVariation: baseline.coefficientOfVariation ?? null,
          tolerance: r.plan.baselineStabilityTolerance,
          minimumSec: r.plan.baselineMinSec,
        };
        transition(
          r,
          'BASELINE',
          `Baseline ${reason}: ${baseline.samples} samples over ${baseline.durationSec}s; no injection`,
        );
        break;
      }
      ensure(!ports.signal.aborted, 'Assessment cancelled before injection');
      // Only bounded HTTP GET can be dispatched by this control plane; other standard
      // lines are reference/import-only, irrespective of a third-party port's claims.
      ensure(
        ids.every((id) => id.endsWith('51002')),
        'Unsupported physical vector; use engine validation or independently archived external evidence',
      );
      transition(r, 'LEVEL_EXECUTION', 'Bounded execution under frozen shared ceiling');
      await save();
      const injection = new AbortController();
      const injectionSignal = AbortSignal.any([
        ports.signal,
        injection.signal,
        AbortSignal.timeout(b.maxDurationSec * 1000),
      ]);
      let handle: Awaited<ReturnType<DrsGeneratorPort['start']>> | undefined;
      try {
        handle = await bounded(DRS_EVIDENCE_LIMITS.capacityTimeoutMs, injectionSignal, (signal) =>
          ports.generator.start(ids, b, signal),
        );
        await bounded(b.maxDurationSec * 1000, injectionSignal, (signal) =>
          ports.collector.observe(ids, r.plan, signal),
        );
      } finally {
        injection.abort();
        if (handle) {
          const receipt = await bounded(
            FLEET_LIMITS.stopTimeoutMs,
            new AbortController().signal,
            () => handle!.stop(),
          );
          ensure(
            receipt.confirmed && Number.isFinite(Date.parse(receipt.stoppedAt)),
            'Injection stop outcome unknown; no next level',
          );
        }
      }
      transition(r, 'RECOVERY', 'Injection stopped; independent post-injection observation');
      await save();
      await bounded(r.plan.recoveryTimeoutSec * 1000, ports.signal, (signal) =>
        ports.collector.recovery(r.plan, signal),
      );
      transition(
        r,
        'EVIDENCE_VALIDATION',
        'Qualify independent collector archive, not generator exit code',
      );
      await save();
      const evidence = await bounded(DRS_EVIDENCE_LIMITS.capacityTimeoutMs, ports.signal, () =>
        ports.collector.seal(ids, r.plan),
      );
      for (const e of evidence) appendProof(r, e, actor, 'collector-import');
      transition(
        r,
        'LEVEL_CALCULATION',
        'Calculate full denominator; later attempts are diagnostics after terminal level',
      );
      await save();
      const result = assessDrs(r);
      if (result.levels.find((l) => l.level === level)?.outcome !== 'PASS') break;
    }
  } catch (err) {
    if (process.env.DRS_DEBUG) console.error('[drs] orchestration error:', (err as Error).message);
    transition(
      r,
      'EVIDENCE_VALIDATION',
      'Orchestration interrupted or capacity unsupported; unobserved scenarios remain NOT_EVALUATED',
    );
  }
  const result = finalize(r);
  await save();
  return result;
}

async function bounded<T>(
  ms: number,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const signal = AbortSignal.any([parent, ac.signal]);
  let timer: ReturnType<typeof setTimeout>;
  let remove = () => {};
  const timeout = new Promise<never>((_, reject) => {
    const abort = () => reject(Error('Observation or execution cancelled/deadline exceeded'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    remove = () => signal.removeEventListener('abort', abort);
    timer = setTimeout(() => ac.abort(), ms);
  });
  try {
    ensure(!signal.aborted, 'Operation cancelled');
    return await Promise.race([operation(signal), timeout]);
  } finally {
    clearTimeout(timer!);
    remove();
  }
}
