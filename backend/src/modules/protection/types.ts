/**
 * Protection integration (measurement, not attack): lets the control plane
 * ingest the REAL detection and mitigation timings from the team's protection
 * layer (WAF / scrubbing / cloud DDoS protection) for a campaign run, so the
 * WRS reflects measured values instead of conservative estimates. Strictly
 * inbound measurement — it generates no traffic.
 */

/** The run window a measurement is requested for. */
export interface ProtectionContext {
  campaignId: string;
  target: string;
  startedAt: string;
  finishedAt: string;
}

/** Real timings reported by the protection layer. */
export interface ProtectionMeasurement {
  detectionTimeSec: number;
  mitigationTimeSec: number;
  /** Optional label of the reporting system (e.g. 'cloudflare', 'scrubbing'). */
  source?: string;
}

/**
 * Provides measured protection timings for a run, or null when none are
 * available (then the WRS keeps its estimate). Implementations MUST NOT throw.
 */
export interface ProtectionProvider {
  /** Whether a real source is configured (surfaced in /health). */
  readonly configured: boolean;
  measure(ctx: ProtectionContext): Promise<ProtectionMeasurement | null>;
}
