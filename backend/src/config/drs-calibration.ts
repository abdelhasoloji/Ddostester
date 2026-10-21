/**
 * How long a calibration admits an agent into the envelope.
 *
 * A measurement is a statement about a machine at a moment: kernels, network paths and drivers
 * change. Thirty days is the default; a deployment that wants stricter or looser can say so,
 * clamped to something that at least allows a monthly cycle.
 */
export function drsCalibrationTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DRS_CALIBRATION_TTL_DAYS ?? 30);
  if (!Number.isFinite(raw)) return 30;
  // One day to one year. Deriving this from the duration cap was wrong: it silently turned the
  // 30-day default into 15.
  return Math.min(Math.max(1, Math.floor(raw)), 365);
}
