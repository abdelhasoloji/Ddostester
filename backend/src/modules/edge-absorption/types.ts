/**
 * Bilateral absorption (I1): corroborate the absorption we INFER from our own
 * side (failed/total) with the absorption the target's EDGE reports from ITS
 * side (requests it saw and blocked/rate-limited). When both agree, the
 * "protection absorbed X%" claim in a client report is evidence, not inference.
 * Strictly inbound measurement — generates no traffic.
 */

/** The run window an edge-absorption report is requested for. */
export interface EdgeAbsorptionContext {
  campaignId: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  /** The X-WEDOS-TEST tag prefix for this run, so the edge can isolate our traffic. */
  tag: string;
}

/** Counts the target edge reports for the run window (its own view). */
export interface EdgeAbsorptionReport {
  /** Requests the edge saw from us. */
  seen: number;
  /** Requests the edge blocked/dropped (4xx/5xx/dropped). */
  blocked: number;
  /** Optional: of `blocked`, how many were rate-limited/tarpitted vs hard-rejected. */
  rateLimited?: number;
  /** Requests the edge forwarded to origin. */
  served: number;
  /** Provenance label (e.g. 'scrubbing', 'waf', 'mock'). */
  source?: string;
}

/**
 * Provides the edge's own absorption counts for a run, or null when no source is
 * available. Implementations MUST NOT throw (return null on any failure).
 */
export interface EdgeAbsorptionProvider {
  /** Whether a real source is configured (surfaced in /health). */
  configured: boolean;
  report(ctx: EdgeAbsorptionContext): Promise<EdgeAbsorptionReport | null>;
}

/** The two-sided comparison attached to a run when a source answered. */
export interface AbsorptionCorroboration {
  /** Absorbed fraction we inferred (our side), 0–1. */
  ourAbsorbedRatio: number;
  /** Absorbed fraction the edge reports (blocked/seen), 0–1. */
  edgeAbsorbedRatio: number;
  /** |ours − edge|, 0–1. */
  agreementDelta: number;
  /** True when the delta is within tolerance (the two sides agree). */
  agrees: boolean;
  source: string;
}
