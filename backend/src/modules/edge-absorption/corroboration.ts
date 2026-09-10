import type { AbsorptionCorroboration, EdgeAbsorptionReport } from './types.js';

/** Default tolerance: the two sides "agree" if within 10 percentage points. */
export const AGREEMENT_TOLERANCE = 0.1;

/**
 * Compares our inferred absorption to the edge's own report. Pure; safe on
 * zero/degenerate inputs.
 */
export function corroborate(
  ourAbsorbedRatio: number,
  report: EdgeAbsorptionReport,
  tolerance = AGREEMENT_TOLERANCE,
): AbsorptionCorroboration {
  const seen = Math.max(0, report.seen);
  const edgeAbsorbedRatio = seen > 0 ? Math.min(1, Math.max(0, report.blocked / seen)) : 0;
  const ours = Math.min(1, Math.max(0, ourAbsorbedRatio));
  const agreementDelta = Math.abs(ours - edgeAbsorbedRatio);
  return {
    ourAbsorbedRatio: ours,
    edgeAbsorbedRatio,
    agreementDelta,
    agrees: agreementDelta <= tolerance,
    source: report.source ?? 'edge',
  };
}
