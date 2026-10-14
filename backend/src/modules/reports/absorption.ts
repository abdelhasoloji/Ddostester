/**
 * Legacy generator delivery/failure summary, retained for historical compatibility.
 * Successful responses do not establish arrival at origin. HTTP failures and
 * transport errors do not establish edge rejection, mitigation or deliberate
 * tarpitting without independent receiver/protection evidence.
 * offeredShortfall describes under-delivery relative to the requested mean rate.
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
  /** @deprecated Compatibility name: successful generator responses per second. */
  originRps: number;
  /** @deprecated Compatibility name: generator failure fraction = failed / total. */
  absorbedRatio: number;
  /** Same as absorbedRatio, as a 0–100 percentage (rounded to 1 decimal). */
  absorbedPct: number;
  /** Total requests attempted. */
  totalRequests: number;
  /** Backpressure: `1 - achieved/configured`, in [0,1]. Latency-bound shortfall,
   *  NOT edge rejection (we never offered this load). */
  offeredShortfall: number;
  /** Legacy name: unsuccessful HTTP response fraction, without attribution. */
  rejectedRatio: number;
  /** Legacy name: transport failure fraction, without attribution. */
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
  /** Count of unsuccessful HTTP responses. Optional. */
  rejected?: number;
  /** Count of transport errors — timeouts/aborts/resets. Optional. */
  tarpitted?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Separate non-success HTTP status buckets from transport failures. These
 * compatibility keys describe observed generator outcomes, not their cause.
 * Fall back to the error map only when no transport status bucket is available.
 */
export function splitFailures(
  statusCounts: Record<string, number>,
  errors: Record<string, number> = {},
): { rejected: number; tarpitted: number } {
  const isTransport = (b: string) => b === '0xx' || b === 'err';
  const rejected = Object.entries(statusCounts)
    .filter(([b]) => b !== '2xx' && b !== '3xx' && !isTransport(b))
    .reduce((s, [, n]) => s + n, 0);
  const transportFailures = Object.entries(statusCounts)
    .filter(([b]) => isTransport(b))
    .reduce((s, [, n]) => s + n, 0);
  const tarpitted = transportFailures || Object.values(errors).reduce((s, n) => s + n, 0);
  return { rejected, tarpitted };
}

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

/**
 * Collapse a raw generator error map into a small, human-readable breakdown.
 *
 * Vegeta keys each error by the exact request it failed on, e.g.
 *   `Post "https://bank.cz/?_cb=0o4hx0v": context deadline exceeded`
 * A cache-busted flood makes every URL unique, so the raw map has one ×1 entry
 * per request — thousands of near-identical lines that are all the same failure
 * ("context deadline exceeded"). This normalizes each key to its underlying
 * error CLASS (stripping the `Method "URL":` prefix and any embedded host/IP/
 * port/duration) and sums the counts, so the report shows
 *   `context deadline exceeded ×63,133`
 * instead of a wall of noise. Returns entries sorted by count, descending.
 */
export function normalizeErrorMap(
  errors: Record<string, number> | undefined | null,
  limit = 6,
): { label: string; count: number }[] {
  if (!errors) return [];
  const byClass = new Map<string, number>();
  for (const [rawKey, n] of Object.entries(errors)) {
    byClass.set(normalizeErrorKey(rawKey), (byClass.get(normalizeErrorKey(rawKey)) ?? 0) + n);
  }
  const sorted = [...byClass.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, limit);
  const otherCount = sorted.slice(limit).reduce((s, e) => s + e.count, 0);
  const otherKinds = sorted.length - limit;
  head.push({ label: `+${otherKinds} other error kinds`, count: otherCount });
  return head;
}

/** Reduce one vegeta error string to its stable error class. Pure. */
export function normalizeErrorKey(raw: string): string {
  // Drop the `Method "URL":` prefix vegeta prepends (the URL carries the unique
  // cache-buster that explodes the map).
  let msg = raw.replace(/^\s*\w+\s+"[^"]*":\s*/, '').trim();
  // Some transports embed the address instead of quoting a URL, e.g.
  //   `dial tcp 1.2.3.4:443: connect: connection refused`. Strip host:port runs.
  msg = msg.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g, '<addr>');
  msg = msg.replace(/https?:\/\/[^\s"]+/g, '<url>');
  // Collapse trailing durations ("... (Client.Timeout exceeded ... 10s)").
  msg = msg.replace(/\b\d+(?:\.\d+)?(?:ms|s|m)\b/g, '<dur>');
  return msg || raw.trim();
}
