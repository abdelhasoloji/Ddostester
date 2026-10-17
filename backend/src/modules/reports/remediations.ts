// Post-test weakness → remediation engine.
//
// After an assessment run, a reader should see not just the score but WHERE the
// resilience is weak and WHAT to do about it. This turns the measured signals
// (availability, detection/mitigation timing, collateral, WRS level, SLO
// verdict) into a ranked list of concrete, actionable remediations. Pure and
// deterministic — same run in, same advice out — so it renders identically in
// the per-campaign and aggregate reports and is easy to test.

import type { Campaign } from '../campaigns/model.js';
import type { CampaignRun } from '../campaigns/runner.js';
import { observedAvailability } from './measurements.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Severity → report pill class. Shared by the per-campaign and aggregate reports. */
export const SEVERITY_PILL: Record<Severity, 'good' | 'warn' | 'crit' | 'neutral'> = {
  critical: 'crit',
  high: 'warn',
  medium: 'warn',
  low: 'neutral',
};

export interface Remediation {
  /** Stable key so identical weaknesses dedupe across runs in the aggregate. */
  id: string;
  severity: Severity;
  /** What was observed (the weakness), phrased from the measurement. */
  weakness: string;
  /** The concrete action to take. */
  remediation: string;
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Derives the ranked weaknesses + remediations for a single run. Empty when the
 * run held cleanly with nothing to advise.
 */
export function deriveRemediations(_campaign: Campaign, run: CampaignRun): Remediation[] {
  const out: Remediation[] = [];
  const w = run.wrs;
  const avail = observedAvailability(run);
  if (avail === null)
    out.push({
      id: 'probe-evidence',
      severity: 'medium',
      weakness:
        'Completed legitimate probe observations are missing or invalid; availability is unknown.',
      remediation:
        'Restore and validate the independent probe before drawing an availability or capacity conclusion.',
    });
  const kill = run.status === 'KILLED_AUTO';

  // 1. Target went down; these observations do not establish the failure location or protection behavior.
  if (avail !== null && (kill || avail === 0)) {
    out.push({
      id: 'availability-loss',
      severity: 'critical',
      weakness: `The legitimate probe found the target unavailable${kill ? ' (auto-killed)' : ''}; these observations do not establish the failure location or protection behavior.`,
      remediation:
        'Correlate probe, generator, origin and protection telemetry before selecting capacity or always-on mitigation changes; verify recovery and repeat within the approved plan.',
    });
  } else if (avail !== null && avail < 99) {
    out.push({
      id: 'availability-degraded',
      severity: avail < 90 ? 'high' : 'medium',
      weakness: `Legitimate availability degraded to ${Math.round(avail)}% during the run — completed probe transactions failed; real-user impact and outage duration require corroboration.`,
      remediation:
        'Check the probe path and resource health, then correlate target and protection telemetry before changing capacity or filtering.',
    });
  }

  // 2. Collateral — mitigation blocked legitimate traffic.
  if (w && w.collateral < 90) {
    out.push({
      id: 'collateral',
      severity: w.collateral < 70 ? 'high' : 'medium',
      weakness: `Legitimate probe degradation was observed (collateral score ${w.collateral}/100); the cause requires independent telemetry.`,
      remediation:
        'Investigate legitimate probe failures with independent origin and protection logs before changing mitigation rules; this diagnostic does not determine DRS compliance.',
    });
  }

  // 3. Detection latency.
  const ttd = run.protection?.detectionTimeSec;
  if (w && w.detection < 70 && ttd != null && Number.isFinite(ttd) && ttd >= 0) {
    out.push({
      id: 'slow-detection',
      severity: 'medium',
      weakness:
        ttd != null
          ? `Detection was slow (time-to-detect ${ttd}s, score ${w.detection}/100).`
          : `Detection scored low (${w.detection}/100).`,
      remediation:
        'Review the reported detection timestamps and detection policy against the frozen campaign objective; this legacy score is not a DRS timing rule.',
    });
  }

  // 4. Mitigation latency.
  const ttm = run.protection?.mitigationTimeSec;
  if (w && w.mitigation < 70 && ttm != null && Number.isFinite(ttm) && ttm >= 0) {
    out.push({
      id: 'slow-mitigation',
      severity: 'medium',
      weakness:
        ttm != null
          ? `Mitigation engaged late (time-to-mitigate ${ttm}s, score ${w.mitigation}/100).`
          : `Mitigation scored low (${w.mitigation}/100).`,
      remediation:
        'Review the reported mitigation timestamps and automation policy against the frozen campaign objective before drawing a mitigation-timing conclusion.',
    });
  }

  // 5. Overall resilience below target.
  if (w && w.wrs < 55) {
    out.push({
      id: 'low-wrs',
      severity: 'high',
      weakness: `Overall resilience is low (WRS ${w.wrs}, level ${w.level}) for this vector.`,
      remediation:
        'Treat this vector as a priority gap: combine the specific remediations above and re-run to verify the WRS recovers to level B or better.',
    });
  }

  // 6. SLO / acceptance failures — surface each explicitly.
  if (run.acceptance && run.acceptance.verdict === 'FAIL') {
    for (const f of run.acceptance.failures.slice(0, 5)) {
      out.push({
        id: `slo:${f}`.slice(0, 80),
        severity: 'high',
        weakness: `SLO not met: ${f}`,
        remediation:
          'Bring the breached SLO back within target (capacity, caching, or edge protection depending on the metric) before sign-off.',
      });
    }
  }

  // 7. Estimated WRS — the assessment itself is not authoritative.
  if (w && w.estimated) {
    out.push({
      id: 'estimated-wrs',
      severity: 'low',
      weakness:
        'Detection and mitigation are estimated — no protection source reported real timings, so the score is not authoritative.',
      remediation:
        'Connect and validate protection telemetry for reported detection/mitigation times, then reconcile it with independent probe and received-load evidence. This alone does not establish DRS compliance.',
    });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/**
 * Aggregates remediations across many runs for the portfolio report: dedupes by
 * id, keeps the highest severity seen and counts how many runs each affected,
 * then ranks. `total` is the number of runs assessed (for context).
 */
export interface AggregatedRemediation extends Remediation {
  affected: number;
}

export function aggregateRemediations(
  runs: { campaign: Campaign; run: CampaignRun }[],
): AggregatedRemediation[] {
  const byId = new Map<string, AggregatedRemediation>();
  for (const { campaign, run } of runs) {
    for (const r of deriveRemediations(campaign, run)) {
      const seen = byId.get(r.id);
      if (!seen) {
        byId.set(r.id, { ...r, affected: 1 });
      } else {
        seen.affected += 1;
        if (RANK[r.severity] < RANK[seen.severity]) seen.severity = r.severity;
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || b.affected - a.affected,
  );
}
