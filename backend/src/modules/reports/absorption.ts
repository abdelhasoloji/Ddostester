/**
 * Protection-absorption: how much of the offered load the target's edge absorbed
 * (rate-limited / tarpitted / 4xx / dropped) versus let through to origin.
 *
 * This is the product-level signal WEDOS cares about — "your protection absorbed
 * X% of Y offered load". Computed from the generator result so the report, the
 * /metrics gauges and the frontend widget all agree (single source of truth).
 *
 * Absorption is broken down by MECHANISM, because an edge can defend two very
 * different ways (bank.cz, e.g., overwhelmingly tarpits rather than 4xx-rejects):
 *  - reject: the edge ANSWERED refusing the request (4xx/5xx) — a fast "no";
 *  - tarpit: the edge HELD the connection until we gave up (timeout/abort) — a
 *    slow "no" that costs the attacker far more.
 * And separately from absorption, `offeredShortfall` captures backpressure: we
 * couldn't even offer the configured rate (latency-bound), which is NOT the edge
 * rejecting traffic and must not be mistaken for it.
 */
export interface Absorption {
  /** Requested ceiling (campaign.maxRps) — the PEAK offered rate, for display. */
  configuredRps: number;
  /**
   * The rate the scenario INTENDED to offer, averaged over its whole duration —
   * the honest denominator for delivery. Equals `configuredRps` for a constant
   * profile; lower for a wave/ramp (whose mean throughput is below their peak).
   * Delivery/shortfall are measured against THIS, not the peak, so a faithfully
   * delivered wave/ramp doesn't read as under-delivered.
   */
  expectedRps: number;
  /** Load we actually sent (generator actualRps). */
  achievedRps: number;
  /** Load that reached origin — successful (2xx/3xx) responses per second. */
  originRps: number;
  /** Fraction absorbed by the edge = failed / total, in [0,1]. */
  absorbedRatio: number;
  /** Same as absorbedRatio, as a 0–100 percentage (rounded to 1 decimal). */
  absorbedPct: number;
  /** Total requests attempted. */
  totalRequests: number;
  /** Backpressure: `1 - achieved/configured`, in [0,1]. Latency-bound shortfall,
   *  NOT edge rejection (we never offered this load). */
  offeredShortfall: number;
  /** Fraction the edge REJECTED with a response (4xx/5xx) / total, in [0,1]. */
  rejectedRatio: number;
  /** Fraction the edge TARPITTED (held → timeout/abort) / total, in [0,1]. */
  tarpitRatio: number;
}

export interface AbsorptionInput {
  configuredRps: number;
  /** The scenario's intended mean offered rate; defaults to `configuredRps`
   *  (constant profile) when omitted. Delivery/shortfall are measured against it. */
  expectedRps?: number;
  achievedRps: number;
  totalRequests: number;
  successful: number;
  failed: number;
  durationSec: number;
  /** Count of 4xx/5xx responses (edge answered, refusing). Optional. */
  rejected?: number;
  /** Count of transport errors — timeouts/aborts/resets (edge held). Optional. */
  tarpitted?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function computeAbsorption(i: AbsorptionInput): Absorption {
  const total = Math.max(0, i.totalRequests);
  // Delivery is measured against the rate the scenario meant to offer (its mean),
  // not the peak — a wave/ramp's mean throughput is naturally below its peak.
  const expectedRps = i.expectedRps ?? i.configuredRps;
  const originRps = i.durationSec > 0 ? i.successful / i.durationSec : 0;
  const absorbedRatio = total > 0 ? i.failed / total : 0;
  const offeredShortfall = expectedRps > 0 ? clamp01(1 - i.achievedRps / expectedRps) : 0;
  const rejectedRatio = total > 0 ? clamp01((i.rejected ?? 0) / total) : 0;
  const tarpitRatio = total > 0 ? clamp01((i.tarpitted ?? 0) / total) : 0;
  return {
    configuredRps: i.configuredRps,
    expectedRps,
    achievedRps: i.achievedRps,
    originRps,
    absorbedRatio,
    absorbedPct: Math.round(absorbedRatio * 1000) / 10,
    totalRequests: total,
    offeredShortfall,
    rejectedRatio,
    tarpitRatio,
  };
}
