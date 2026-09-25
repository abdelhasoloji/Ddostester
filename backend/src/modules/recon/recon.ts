import { analyzePosture } from '../posture/analyze.js';
import type { PostureReport } from '../posture/analyze.js';
import { postureToProfile } from '../reports/gap-analysis.js';
import type { ProtectionProfile } from '../reports/gap-analysis.js';
// Type-only import — model.ts never imports recon, so no cycle.
import type { ReconPostureSnapshot } from '../campaigns/model.js';

/**
 * Preparation-phase reconnaissance (defensive, passive + published-surface only).
 *
 * Gives the tool VISION before a test: from the legitimate probe's own responses
 * and what the target PUBLISHES (robots.txt, sitemap, homepage links), it builds
 * a target profile, a real path set, a pre-test baseline and a go/no-go
 * preflight — and seeds the gap-analyzer profile + playbook paths from it.
 *
 * The boundary is the same as everywhere else: passive and published-surface
 * only, capped, allowlisted, authorized. No port scan, no vulnerability scan, no
 * path fuzzing / brute-force, no enumeration of non-published resources. It
 * reads what the target exposes and what the probe already receives — nothing
 * intrusive. The pure cores here take already-captured data; the bounded network
 * orchestration lives in ./fetch.ts.
 */

// ── Target profile (A) ───────────────────────────────────────────────────────

export type CacheBehavior = 'hit' | 'miss' | 'dynamic' | 'unknown';

export interface TargetProfile {
  posture: PostureReport;
  /** Recognised protection/CDN vendor, if the signals name one. */
  vendor?: string;
  protocols: { http2: boolean; http3: boolean };
  /** Negotiated TLS version, when the orchestrator captured it. */
  tls?: string;
  cache: CacheBehavior;
  server?: string;
}

function lower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

const VENDORS: [RegExp, string][] = [
  [/cloudflare|cf-ray/i, 'Cloudflare'],
  [/akamai/i, 'Akamai'],
  [/fastly/i, 'Fastly'],
  [/sucuri/i, 'Sucuri'],
  [/imperva|incapsula/i, 'Imperva'],
  [/wedos|x-wedos-shield/i, 'WEDOS'],
];

/** Names the protection/CDN vendor from the posture signals + server header. */
export function detectVendor(posture: PostureReport): string | undefined {
  const hay = [posture.server ?? '', ...posture.signals].join(' ');
  for (const [re, name] of VENDORS) if (re.test(hay)) return name;
  return undefined;
}

/** HTTP/2 + HTTP/3 support from Alt-Svc advertisements (and an optional hint). */
export function detectProtocols(
  headerSnapshots: Record<string, string>[],
  negotiated?: string,
): { http2: boolean; http3: boolean } {
  let http2 = negotiated === 'h2' || negotiated === 'http/2';
  let http3 = false;
  for (const snap of headerSnapshots) {
    const altSvc = lower(snap)['alt-svc'];
    if (!altSvc) continue;
    if (/h3(-\d+)?=/.test(altSvc)) http3 = true;
    if (/h2=/.test(altSvc)) http2 = true;
  }
  return { http2, http3 };
}

/** Cache behaviour from edge cache-status headers / Age. */
export function detectCache(headerSnapshots: Record<string, string>[]): CacheBehavior {
  for (const snap of headerSnapshots) {
    const h = lower(snap);
    const status = (h['cf-cache-status'] ?? h['x-cache'] ?? '').toLowerCase();
    if (/hit/.test(status)) return 'hit';
    if (/miss|expired/.test(status)) return 'miss';
    if (/dynamic|bypass/.test(status)) return 'dynamic';
    if (h['age'] != null && Number(h['age']) > 0) return 'hit';
  }
  return 'unknown';
}

export function buildTargetProfile(
  headerSnapshots: Record<string, string>[],
  statuses: number[],
  opts: { negotiatedProtocol?: string; tls?: string } = {},
): TargetProfile {
  const posture = analyzePosture(headerSnapshots, statuses);
  return {
    posture,
    vendor: detectVendor(posture),
    protocols: detectProtocols(headerSnapshots, opts.negotiatedProtocol),
    tls: opts.tls,
    cache: detectCache(headerSnapshots),
    server: posture.server,
  };
}

/** Seeds the gap-analyzer control profile from the observed posture (E). */
export function profileToProtectionProfile(profile: TargetProfile): ProtectionProfile {
  return postureToProfile(profile.posture);
}

// ── Published-surface map (B) ─────────────────────────────────────────────────

export interface Surface {
  /** De-duplicated, capped set of real same-host paths worth exercising,
   *  ranked so the paths most likely to cost the origin come first (P1). */
  paths: string[];
  /** The subset of `paths` that look dynamic/expensive (positive cost) — the
   *  ones worth flooding to actually pressure the origin, not its cache. */
  dynamicPaths: string[];
  /** Best-guess login/account path, if one surfaced. */
  loginPath?: string;
  /** Sitemap URLs advertised by robots.txt. */
  sitemaps: string[];
  /** Paths robots.txt asked crawlers not to touch (we respect these). */
  disallow: string[];
}

export interface RobotsInfo {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
}

/** Parses a robots.txt into its Disallow / Allow / Sitemap directives. Pure. */
export function parseRobots(text: string): RobotsInfo {
  const disallow: string[] = [];
  const allow: string[] = [];
  const sitemaps: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const directive = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) continue;
    if (directive === 'disallow') disallow.push(value);
    else if (directive === 'allow') allow.push(value);
    else if (directive === 'sitemap') sitemaps.push(value);
  }
  return { disallow, allow, sitemaps };
}

/** Extracts <loc> URLs from a sitemap XML. Pure. */
export function parseSitemapUrls(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/**
 * Decodes the HTML character references that legitimately appear inside href/src
 * attribute values — chiefly `&amp;` (an unescaped `&` is invalid in HTML, so a
 * multi-parameter link is authored as `?a=1&amp;b=2`), plus the other named and
 * numeric refs. Without this, a discovered path keeps its HTML-escaped source
 * form (`?a=1&amp;b=2`) instead of the URL the browser would actually request
 * (`?a=1&b=2`), and the generator would then flood a wrong query string. Single
 * pass, matching how a browser decodes an attribute value. Pure.
 */
export function decodeHtmlEntities(s: string): string {
  const NAMED: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Same-host paths referenced by href/src in an HTML page. Pure. */
export function extractPaths(html: string, host: string): string[] {
  const out = new Set<string>();
  const re = /(?:href|src)\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const ref = decodeHtmlEntities(m[1].trim());
    if (!ref || ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('tel:'))
      continue;
    const p = toSameHostPath(ref, host);
    if (p) out.add(p);
  }
  return [...out];
}

/** Resolves a same-host reference to its path+search, or null if off-host. */
function toSameHostPath(ref: string, host: string): string | null {
  if (ref.startsWith('/')) return ref;
  if (/^https?:\/\//i.test(ref)) {
    try {
      const u = new URL(ref);
      if (u.hostname === host) return u.pathname + u.search;
    } catch {
      return null;
    }
    return null;
  }
  return null; // ignore relative-without-slash (ambiguous) and protocol-relative
}

const LOGIN_RE = /(login|sign-?in|account|auth|realms|connexion|compte)/i;

/** Picks the most login-like path from a set. Pure. */
export function pickLoginPath(paths: string[]): string | undefined {
  return paths.find((p) => LOGIN_RE.test(p));
}

// Static-asset extensions: these are cheap for the origin (usually cached/served
// straight off disk or a CDN) so they make poor stress targets.
const STATIC_EXT_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|pdf)(?:$|\?)/i;
const STATIC_PREFIX_RE = /^\/(?:static|assets|_next\/static|wp-content|wp-includes|cdn|dist)\//i;
// Dynamic / server-work indicators: these hit application logic (DB, auth,
// rendering) and are what actually pressures an origin.
const DYNAMIC_HINT_RE =
  /(?:\/api\/|\/graphql|\/search|\/login|\/signin|\/auth|\/account|\/cart|\/checkout|\/register|\/reset|\/wp-json|\/wp-admin|\/wp-login|\.php|\.aspx?|\.jsp|\.cgi|\/rest\/|\/v\d+\/)/i;

/**
 * Heuristic "cost to the origin" score for a discovered path — higher = more
 * likely to make the origin do real work (DB/auth/render), so a better stress
 * target than a cached static asset. Pure. Used to rank the recon surface so the
 * expensive paths survive the cap and seed the load steps (P1).
 */
export function pathCost(path: string): number {
  let score = 0;
  if (STATIC_EXT_RE.test(path) || STATIC_PREFIX_RE.test(path)) score -= 10;
  if (path.includes('?')) score += 3; // a query string = parameterised = dynamic
  if (DYNAMIC_HINT_RE.test(path)) score += 5;
  if (LOGIN_RE.test(path)) score += 2; // auth is expensive (hashing, sessions)
  // A deeper path is usually more specific/dynamic than a top-level landing page.
  score += Math.min(2, (path.replace(/\/+$/, '').match(/\//g)?.length ?? 1) - 1);
  return score;
}

/** Does a path fall under any robots Disallow prefix? */
function isDisallowed(path: string, disallow: string[]): boolean {
  return disallow.some((d) => d !== '/' && path.startsWith(d));
}

export function buildSurface(
  input: { robots?: string; sitemapXml?: string; homepageHtml?: string; host: string },
  cap = 12,
): Surface {
  const robots = input.robots
    ? parseRobots(input.robots)
    : { disallow: [], allow: [], sitemaps: [] };
  const fromSitemap = input.sitemapXml
    ? parseSitemapUrls(input.sitemapXml)
        .map((u) => toSameHostPath(u, input.host))
        .filter((p): p is string => p != null)
    : [];
  const fromHtml = input.homepageHtml ? extractPaths(input.homepageHtml, input.host) : [];

  // De-dupe the discovered paths (excluding root + robots-Disallow), then RANK
  // them by likely cost to the origin (P1) so the expensive/dynamic paths survive
  // the cap and seed the load — a flood of cached static assets barely touches
  // the origin. Root is always kept first as the baseline anchor. The sort is
  // stable, so equal-cost paths keep their discovery order.
  const seen = new Set<string>(['/']);
  const discovered: string[] = [];
  for (const p of [...fromSitemap, ...fromHtml]) {
    if (seen.has(p) || isDisallowed(p, robots.disallow)) continue;
    seen.add(p);
    discovered.push(p);
  }
  discovered.sort((a, b) => pathCost(b) - pathCost(a));
  const paths = ['/', ...discovered].slice(0, cap);
  const dynamicPaths = paths.filter((p) => p !== '/' && pathCost(p) > 0);
  return {
    paths,
    dynamicPaths,
    loginPath: pickLoginPath(paths),
    sitemaps: robots.sitemaps,
    disallow: robots.disallow,
  };
}

// ── Pre-test baseline (C) ─────────────────────────────────────────────────────

export interface Baseline {
  samples: number;
  availabilityPct: number;
  latencyP50: number;
  latencyP95: number;
  latencyMean: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Summarises warmup probe samples into a normal-operation baseline. Pure. */
export function computeBaseline(
  samples: { ok: boolean; latencyMs: number; status?: number }[],
): Baseline {
  const n = samples.length;
  if (n === 0)
    return { samples: 0, availabilityPct: 0, latencyP50: 0, latencyP95: 0, latencyMean: 0 };
  const ok = samples.filter((s) => s.ok).length;
  const lat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const mean = lat.reduce((a, b) => a + b, 0) / n;
  return {
    samples: n,
    availabilityPct: Number(((ok / n) * 100).toFixed(1)),
    latencyP50: percentile(lat, 50),
    latencyP95: percentile(lat, 95),
    latencyMean: Number(mean.toFixed(1)),
  };
}

/**
 * The HTTP status the probe kept returning when it never succeeded, so the
 * preflight can say WHY it is unreachable (e.g. a probe path that 404s) instead
 * of a vague "no successful sample". Returns the most common non-zero status, or
 * undefined when every sample was a network error (no status). Pure.
 */
export function dominantProbeStatus(
  samples: { ok: boolean; latencyMs: number; status?: number }[],
): number | undefined {
  const counts = new Map<number, number>();
  for (const sm of samples) {
    if (typeof sm.status === 'number' && sm.status > 0) {
      counts.set(sm.status, (counts.get(sm.status) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestN = 0;
  for (const [st, n] of counts) {
    if (n > bestN) {
      best = st;
      bestN = n;
    }
  }
  return best;
}

// ── Preflight go/no-go (D) ────────────────────────────────────────────────────

export interface PreflightItem {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export interface Preflight {
  items: PreflightItem[];
  go: boolean;
}

export interface PreflightInput {
  targetAllowed: boolean;
  probeAllowed: boolean;
  probeReachable: boolean;
  enginesAvailable: number;
  capsConfigured: boolean;
  protectionConfigured: boolean;
  labRunnerConfigured: boolean;
  /** When the probe never succeeded, the HTTP status it kept returning (if any) —
   *  lets the checklist explain a 404/403 probe path instead of a vague failure. */
  probeStatus?: number;
}

/** Builds the readiness checklist; go = every REQUIRED item passes. Pure. */
export function preflight(i: PreflightInput): Preflight {
  const items: PreflightItem[] = [
    {
      key: 'target-allowed',
      label: 'Target in ALLOWED_TARGETS',
      ok: i.targetAllowed,
      required: true,
      detail: i.targetAllowed ? 'allowlisted' : 'not allowlisted — add it before running',
    },
    {
      key: 'probe-allowed',
      label: 'Probe URL allowlisted',
      ok: i.probeAllowed,
      required: true,
      detail: i.probeAllowed ? 'allowlisted' : 'probe host not in the allowlist',
    },
    {
      key: 'probe-reachable',
      label: 'Probe reachable',
      ok: i.probeReachable,
      required: true,
      detail: i.probeReachable
        ? 'responds to the legitimate probe'
        : i.probeStatus
          ? `probe URL returned HTTP ${i.probeStatus} — pick an endpoint that serves 2xx (e.g. the site root "/")`
          : 'no successful probe sample',
    },
    {
      key: 'engines',
      label: 'Load engine available',
      ok: i.enginesAvailable > 0,
      required: true,
      detail: `${i.enginesAvailable} engine(s) available`,
    },
    {
      key: 'caps',
      label: 'Operational caps configured',
      ok: i.capsConfigured,
      required: true,
      detail: i.capsConfigured ? 'caps enforced' : 'no caps configured',
    },
    {
      key: 'protection',
      label: 'Protection hook wired (measured TTD/TTM)',
      ok: i.protectionConfigured,
      required: false,
      detail: i.protectionConfigured
        ? 'scrubber hook configured'
        : 'not wired — detect/mitigate timing will be estimated, not measured',
    },
    {
      key: 'lab-runner',
      label: 'Class-C lab runner configured',
      ok: i.labRunnerConfigured,
      required: false,
      detail: i.labRunnerConfigured
        ? 'lab targets configured'
        : 'no lab runner — the L3/4 TCP line cannot run',
    },
  ];
  return { items, go: items.every((it) => !it.required || it.ok) };
}

// ── Assembly (E) ──────────────────────────────────────────────────────────────

export interface ReconReport {
  target: string;
  probeUrl: string;
  generatedAt: string;
  profile: TargetProfile;
  surface: Surface;
  baseline: Baseline;
  preflight: Preflight;
  /** Gap-analyzer control profile seeded from the observed posture. */
  seededProfile: ProtectionProfile;
  /** Real paths to feed the playbook steps, ranked by likely cost to the origin. */
  suggestedPaths: string[];
  /** The dynamic/expensive subset of suggestedPaths — the best stress targets. */
  dynamicPaths: string[];
  loginPath?: string;
}

/**
 * THE single source of the recon-posture → target-requirement mapping: which of
 * {h2, waf, cache, dynamic} the target exhibits. A template's `requires` is then
 * N/A wherever the corresponding feature is false (a benign result against a
 * missing feature is not resistance). Was duplicated inline in `app.ts` reconSeed,
 * `scripts/template-matrix.mjs`, and the `model.ts` doc-comment — keep those
 * pointing here so the mapping can never drift.
 */
export function reconPostureSnapshot(recon: ReconReport): ReconPostureSnapshot {
  return {
    h2: !!recon.profile.protocols.http2,
    waf: !!recon.profile.posture.waf,
    cache: recon.profile.cache === 'hit' || !!recon.profile.posture.cdn,
    dynamic: (recon.dynamicPaths?.length ?? 0) > 0,
  };
}

export interface AssembleInput {
  target: string;
  probeUrl: string;
  headerSnapshots: Record<string, string>[];
  statuses: number[];
  negotiatedProtocol?: string;
  tls?: string;
  host: string;
  robots?: string;
  sitemapXml?: string;
  homepageHtml?: string;
  baselineSamples: { ok: boolean; latencyMs: number; status?: number }[];
  preflightInput: Omit<PreflightInput, 'probeReachable'>;
}

/** Assembles a full recon report from already-captured data. Pure + testable. */
export function assembleReconReport(input: AssembleInput): ReconReport {
  const profile = buildTargetProfile(input.headerSnapshots, input.statuses, {
    negotiatedProtocol: input.negotiatedProtocol,
    tls: input.tls,
  });
  const surface = buildSurface({
    robots: input.robots,
    sitemapXml: input.sitemapXml,
    homepageHtml: input.homepageHtml,
    host: input.host,
  });
  const baseline = computeBaseline(input.baselineSamples);
  // When the probe never succeeded, surface WHY (e.g. a 404 probe path) so a
  // NO-GO reads as an actionable config fix, not a phantom target outage.
  const probeStatus =
    baseline.availabilityPct === 0 ? dominantProbeStatus(input.baselineSamples) : undefined;
  const pf = preflight({
    ...input.preflightInput,
    probeReachable: baseline.availabilityPct > 0,
    probeStatus,
  });
  return {
    target: input.target,
    probeUrl: input.probeUrl,
    generatedAt: new Date().toISOString(),
    profile,
    surface,
    baseline,
    preflight: pf,
    seededProfile: profileToProtectionProfile(profile),
    suggestedPaths: surface.paths,
    dynamicPaths: surface.dynamicPaths,
    loginPath: surface.loginPath,
  };
}
