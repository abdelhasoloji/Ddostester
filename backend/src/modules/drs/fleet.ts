/**
 * Who is admitted into the envelope.
 *
 * A calibration says a machine measured X at a date. Admission adds two facts the calibration
 * cannot know: whether the machine is in service, and whether the measurement is still fresh.
 * Keeping this decision in one pure function means the capacity screen, the envelope and the
 * fleet page cannot disagree about it.
 */
import type { AgentCalibration } from './calibration.js';
import type { DrsAgent } from './agent.js';

export type ExclusionReason = 'maintenance' | 'retired' | 'calibration-expired';

export interface AdmittedAgent {
  id: string;
  label: string;
  measuredTps: number;
  measuredConcurrency: number;
  measuredAt: string;
  state: DrsAgent['state'];
}

export interface ExcludedAgent {
  id: string;
  reason: ExclusionReason;
  detail: string;
}

export interface Admission {
  admitted: AdmittedAgent[];
  excluded: ExcludedAgent[];
}

const DAY_MS = 86_400_000;

export function admitAgents(
  calibrations: AgentCalibration[],
  agents: DrsAgent[],
  opts: { now?: Date; ttlDays?: number } = {},
): Admission {
  const now = opts.now ?? new Date();
  const ttlDays = opts.ttlDays ?? 30;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const admitted: AdmittedAgent[] = [];
  const excluded: ExcludedAgent[] = [];

  for (const c of calibrations) {
    // An agent without a fleet record predates the record: treat it as active rather than
    // silently removing capacity that exists.
    const state = byId.get(c.agentId)?.state ?? 'active';
    if (state === 'maintenance') {
      excluded.push({ id: c.agentId, reason: 'maintenance', detail: 'agent in maintenance' });
      continue;
    }
    if (state === 'retired') {
      excluded.push({ id: c.agentId, reason: 'retired', detail: 'agent retired' });
      continue;
    }
    const ageDays = (now.getTime() - Date.parse(c.measuredAt)) / DAY_MS;
    if (Number.isFinite(ageDays) && ageDays > ttlDays) {
      excluded.push({
        id: c.agentId,
        reason: 'calibration-expired',
        detail: `calibrated ${Math.floor(ageDays)} days ago, limit ${ttlDays}`,
      });
      continue;
    }
    admitted.push({
      id: c.agentId,
      label: byId.get(c.agentId)?.label ?? c.agentId,
      measuredTps: c.measuredTps,
      measuredConcurrency: c.measuredConcurrency,
      measuredAt: c.measuredAt,
      state,
    });
  }
  return { admitted, excluded };
}

/** Calibration age in days, or null when the date cannot be read. */
export function calibrationAgeDays(measuredAt: string, now = new Date()): number | null {
  const age = (now.getTime() - Date.parse(measuredAt)) / DAY_MS;
  return Number.isFinite(age) ? Math.max(0, Math.floor(age)) : null;
}
