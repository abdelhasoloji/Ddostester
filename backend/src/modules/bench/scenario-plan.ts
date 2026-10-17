import { drsReference, digest, type DrsVector } from '../drs/reference.js';
import { drsSequencePlan } from '../drs/sequence.js';
import { ensure } from '../drs/model.js';
import { SYNTHETIC_JOURNEY_LIMITS as LIMITS } from '../../config/limits.js';
export interface SyntheticEntry {
  vectorId: string;
  name: string;
  level: number;
  execution: 'LAB_MEASUREMENT' | 'SIMULATION';
  scenarioId: string;
  referenceVector: DrsVector;
  referenceHash: string;
}
export interface SyntheticResult {
  kind: 'LAB_MEASUREMENT' | 'SIMULATION' | 'NOT_EVALUATED';
  outcome: string;
  at: string;
  reason?: string;
  referenceHash?: string;
  model?: 'reference-lifecycle/1';
  trace?: string[];
  runId?: string;
  receivedBps: number | null;
  acceptedConnections?: number | null;
  drsScoreEligible: false;
}
export interface SyntheticStep {
  scenarioId: string;
  vectorId?: string;
  name?: string;
  level?: number;
  execution?: SyntheticEntry['execution'];
  runId?: string;
  result?: SyntheticResult;
}
export interface SyntheticDefinition {
  schema: 'shieldtester.synthetic-plan/v1' | 'shieldtester.synthetic-plan/v2';
  reference: ReturnType<typeof drsSequencePlan>;
  labTarget: string;
  scenarios: string[];
  entries?: SyntheticEntry[];
}
/** Retained solely to verify frozen legacy plans, never to rewrite their history. */
export function legacySyntheticDefinition(
  level: number,
  intervalSec: number,
  labTarget: string,
): SyntheticDefinition {
  const reference = drsSequencePlan(level, intervalSec);
  return {
    schema: 'shieldtester.synthetic-plan/v1',
    reference,
    labTarget,
    scenarios: [
      ...new Set(reference.rows.flatMap((r) => (r.laboratory ? [r.laboratory.scenarioId] : []))),
    ],
  };
}
export function syntheticDefinition(
  level: number,
  intervalSec: number,
  labTarget: string,
): SyntheticDefinition {
  ensure(level <= LIMITS.maxLevel, 'Synthetic reference journeys currently cover levels 1–5');
  const reference = drsSequencePlan(level, intervalSec),
    vectors = new Map(drsReference().vectors.map((v) => [v.internal_id, v]));
  ensure(reference.rows.length <= LIMITS.maxSteps, 'Synthetic reference step bound exceeded');
  const entries = reference.rows.map((row) => {
    const vector = vectors.get(row.id)!;
    return {
      vectorId: row.id,
      name: row.name,
      level: row.level,
      execution: row.laboratory ? ('LAB_MEASUREMENT' as const) : ('SIMULATION' as const),
      scenarioId: row.laboratory?.scenarioId ?? row.id,
      referenceVector: vector,
      referenceHash: digest(vector),
    };
  });
  return {
    schema: 'shieldtester.synthetic-plan/v2',
    reference,
    labTarget,
    scenarios: entries.map((e) => e.scenarioId),
    entries,
  };
}
/** Reference-driven lifecycle replay; it models no target resilience and opens no socket. */
export function simulateReference(entry: SyntheticEntry, at: string): SyntheticResult {
  ensure(
    entry.execution === 'SIMULATION' && digest(entry.referenceVector) === entry.referenceHash,
    'Invalid simulation reference',
  );
  return {
    kind: 'SIMULATION',
    outcome: 'REFERENCE_LIFECYCLE_REPLAYED',
    at,
    referenceHash: entry.referenceHash,
    model: 'reference-lifecycle/1',
    trace: ['REFERENCE_LOADED', 'BASELINE_SIMULATED', 'EXPOSURE_SIMULATED', 'RECOVERY_SIMULATED'],
    reason:
      'No registered generator reproduces this vector. Reference-driven workflow simulation only; no traffic, service behavior or resilience measured.',
    receivedBps: null,
    drsScoreEligible: false,
  };
}
