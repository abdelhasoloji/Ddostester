/**
 * Security-posture inference (defensive, passive): from the LEGITIMATE probe's
 * own responses, infer which protection components sit in front of the target
 * (WAF/CDN, rate limiting, load balancer, transport security). It sends no
 * extra traffic and never probes for vulnerabilities — it only reads response
 * metadata already returned to the probe. This is the safe equivalent of
 * Avydos' "misconfiguration detection".
 */

export interface PostureReport {
  waf: boolean;
  cdn: boolean;
  rateLimiting: boolean;
  loadBalancer: boolean;
  hsts: boolean;
  /** Recognised hardening response headers that were present. */
  securityHeaders: string[];
  /** Reported `server` header value, if any. */
  server?: string;
  /** Human-readable signals that led to the findings. */
  signals: string[];
}

const WAF_CDN_HEADERS = [
  'cf-ray',
  'cf-cache-status',
  'x-sucuri-id',
  'x-akamai-transformed',
  'x-amz-cf-id',
  'x-cdn',
  'x-cache',
  'x-served-by',
  'via',
  'x-waf',
  'x-wedos-shield',
  // WEDOS Global Protection / CDN advertise themselves by dedicated headers
  // (an edge fronting a bare origin — the exact before/after this tool proves).
  'x-cdn-cache-status',
  'x-cdn-provider',
  'x-cdn-by',
  'x-protected-by',
  'x-waf-protected-by',
];
/** Header keys whose PRESENCE alone signals a WAF/protection layer (not just a CDN). */
const WAF_HEADERS = new Set([
  'cf-ray',
  'x-sucuri-id',
  'x-waf',
  'x-wedos-shield',
  'x-protected-by',
  'x-waf-protected-by',
]);
/**
 * WEDOS Protection describes ITSELF by product name across several `x-*` headers
 * (x-protected-by, x-waf-protected-by, x-provider, x-cdn-provider, x-filter-info…),
 * so we also match by VALUE — otherwise a WEDOS-fronted origin whose header keys we
 * don't enumerate reads as a bare origin, which is exactly the false-negative this
 * proving ground must never produce about its own product.
 */
const WEDOS_WAF_VALUE = /wedos[\s.]*(global\s+)?protection/i;
const WEDOS_CDN_VALUE = /wedos[\s.]*(global\s+)?cdn|wedos\.delivery/i;
const RATE_LIMIT_HEADERS = ['retry-after', 'x-ratelimit-limit', 'ratelimit-limit', 'x-rate-limit'];
const LB_COOKIE_NAMES = ['awsalb', 'awsalbcors', 'serverid', 'lb', 'route', 'x-served-by'];
const SECURITY_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
];

/** Lower-cases all header keys of a snapshot. */
function lower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Analyses probe response headers + statuses into a posture report. Pure.
 */
export function analyzePosture(
  headerSnapshots: Record<string, string>[],
  statuses: number[],
): PostureReport {
  const signals = new Set<string>();
  const securityHeaders = new Set<string>();
  let waf = false;
  let cdn = false;
  let rateLimiting = false;
  let loadBalancer = false;
  let hsts = false;
  let server: string | undefined;

  for (const snap of headerSnapshots) {
    const h = lower(snap);
    for (const key of WAF_CDN_HEADERS) {
      if (h[key] != null) {
        cdn = true;
        if (WAF_HEADERS.has(key)) waf = true;
        signals.add(`header ${key}`);
      }
    }
    // Value-based product fingerprint (WEDOS advertises itself by name across
    // several x-* headers), so a WEDOS-fronted origin is never mis-read as bare.
    for (const [key, val] of Object.entries(h)) {
      if (WEDOS_WAF_VALUE.test(val)) {
        waf = true;
        cdn = true; // WEDOS Protection is an anycast edge in front of the origin
        signals.add(`WEDOS Protection (${key})`);
      } else if (WEDOS_CDN_VALUE.test(val)) {
        cdn = true;
        signals.add(`WEDOS CDN (${key})`);
      }
    }
    const serverVal = h['server'];
    if (serverVal) {
      server = serverVal;
      if (/cloudflare|sucuri|imperva|akamai|fastly|awselb|barracuda/i.test(serverVal)) {
        cdn = true;
        signals.add(`server: ${serverVal}`);
      }
    }
    for (const key of RATE_LIMIT_HEADERS) {
      if (h[key] != null) {
        rateLimiting = true;
        signals.add(`rate-limit header ${key}`);
      }
    }
    if (h['strict-transport-security'] != null) {
      hsts = true;
      signals.add('HSTS enabled');
    }
    for (const key of SECURITY_HEADERS) {
      if (h[key] != null) securityHeaders.add(key);
    }
    const setCookie = h['set-cookie'];
    if (setCookie) {
      const lc = setCookie.toLowerCase();
      if (LB_COOKIE_NAMES.some((n) => lc.includes(n))) {
        loadBalancer = true;
        signals.add('load-balancer affinity cookie');
      }
    }
    if (h['x-served-by'] != null || h['x-backend'] != null) {
      loadBalancer = true;
      signals.add('backend/served-by header');
    }
  }

  if (statuses.includes(429)) {
    rateLimiting = true;
    signals.add('observed HTTP 429 (rate limited)');
  }

  return {
    waf,
    cdn,
    rateLimiting,
    loadBalancer,
    hsts,
    securityHeaders: [...securityHeaders].sort(),
    server,
    signals: [...signals],
  };
}
