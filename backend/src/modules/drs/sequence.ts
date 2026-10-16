import { drsCatalog } from './catalog.js';
import { digest } from './reference.js';
import { ensure } from './model.js';
import { DRS_SEQUENCE_LIMITS } from '../../config/limits.js';
export function drsSequencePlan(targetLevel: number, intervalSec: number) {
  ensure(
    Number.isInteger(targetLevel) && targetLevel >= 1 && targetLevel <= 7,
    'Target DRS level must be 1–7',
  );
  ensure(
    Number.isInteger(intervalSec) &&
      intervalSec >= 0 &&
      intervalSec <= DRS_SEQUENCE_LIMITS.maxIntervalSec,
    'Invalid scenario interval',
  );
  const catalogue = drsCatalog();
  const rows = catalogue.profiles
    .filter((p) => p.level <= targetLevel)
    .sort((a, b) => a.level - b.level);
  const definition = {
    schema: 'shieldtester.drs.sequence/v1' as const,
    targetLevel,
    intervalSec,
    catalogueHash: catalogue.catalogueHash,
    rows,
  };
  return {
    ...definition,
    planHash: digest(definition),
    executable: rows.filter((r) => r.supported).length,
    blocked: rows.filter((r) => !r.supported).length,
    measuredLevel: null,
  };
}
export interface DrsSequenceBinding {
  referenceRows: ReturnType<typeof drsSequencePlan>['rows'];
  schema: 'shieldtester.drs.sequence/v1';
  targetLevel: number;
  intervalSec: number;
  catalogueHash: string;
  planHash: string;
}

/** Cancellable minimum interval. Pause holds admission after the interval expires. */
export async function waitForScenarioInterval(
  control: { paused: boolean; cancelled: boolean; intervalEndsAt?: number },
  intervalSec: number,
  options: { sleep: (ms: number) => Promise<void>; now: () => number; isStopping: () => boolean },
) {
  control.intervalEndsAt = options.now() + intervalSec * 1000;
  try {
    while (!control.cancelled && !options.isStopping() && options.now() < control.intervalEndsAt)
      await options.sleep(Math.min(400, control.intervalEndsAt - options.now()));
    while (control.paused && !control.cancelled && !options.isStopping()) await options.sleep(400);
    return !control.cancelled && !options.isStopping();
  } finally {
    control.intervalEndsAt = undefined;
  }
}

/** Reconstruct the saved chain without reinterpreting old capability decisions. */
export function savedDrsSequencePlan(binding: DrsSequenceBinding) {
  const definition = {
    schema: binding.schema,
    targetLevel: binding.targetLevel,
    intervalSec: binding.intervalSec,
    catalogueHash: binding.catalogueHash,
    rows: binding.referenceRows,
  };
  ensure(
    Array.isArray(definition.rows) && digest(definition) === binding.planHash,
    'Saved campaign chain integrity failed',
  );
  return {
    ...definition,
    planHash: binding.planHash,
    executable: definition.rows.filter((r) => r.supported).length,
    blocked: definition.rows.filter((r) => !r.supported).length,
    measuredLevel: null,
  };
}
