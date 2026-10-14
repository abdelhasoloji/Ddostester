export interface FleetProgress {
  sent: number;
  successful: number;
  failed: number;
  elapsedSec: number;
  actualRps: number;
}
export function validateFleetProgress(value: unknown, previous?: FleetProgress): FleetProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid fleet progress');
  const x = value as FleetProgress;
  if (
    Object.keys(x).some(
      (k) => !['sent', 'successful', 'failed', 'elapsedSec', 'actualRps'].includes(k),
    ) ||
    ![x.sent, x.successful, x.failed].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    x.successful + x.failed > x.sent ||
    ![x.elapsedSec, x.actualRps].every((n) => Number.isFinite(n) && n >= 0)
  )
    throw new Error('Invalid fleet counters');
  if (previous && (['sent', 'successful', 'failed'] as const).some((k) => x[k] < previous[k]))
    throw new Error('Fleet counters moved backwards');
  return { ...x };
}
