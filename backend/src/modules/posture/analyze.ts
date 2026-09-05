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
];
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
        if (
          key === 'cf-ray' ||
          key === 'x-sucuri-id' ||
          key === 'x-waf' ||
          key === 'x-wedos-shield'
        )
          waf = true;
        signals.add(`header ${key}`);
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
