import { assembleReconReport, type ReconReport, type PreflightInput } from './recon.js';
import { hostOf } from '../../util/net.js';

/**
 * Bounded, allowlisted network orchestration for the preparation phase. Kept
 * separate from recon.ts (the pure cores) because it needs a live, authorized
 * target — it is integration-only, like the other engine run() paths, and is
 * excluded from unit coverage. Everything it does is passive or published-
 * surface: a HEAD/GET of the homepage, robots.txt, sitemap.xml, and a handful
 * of low-rate baseline GETs of the probe URL. No scanning, no fuzzing, capped
 * on every axis.
 */

const BASELINE_SAMPLES = 5;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 512 * 1024; // cap captured bodies (robots/sitemap/homepage)

function snapshot(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function get(
  url: string,
): Promise<{ res: Response; body: string; ms: number } | { error: true; ms: number }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    const buf = await res.arrayBuffer();
    const body = new TextDecoder().decode(buf.slice(0, MAX_BODY_BYTES));
    return { res, body, ms: Date.now() - started };
  } catch {
    return { error: true, ms: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Runs the preparation-phase recon against an allowlisted, authorized target.
 * Throws if the target or probe host is not in the allowlist.
 */
export async function runRecon(
  target: string,
  probeUrl: string,
  allowedHosts: string[],
  flags: Omit<PreflightInput, 'probeReachable' | 'targetAllowed' | 'probeAllowed'>,
): Promise<ReconReport> {
  const host = hostOf(target);
  const probeHost = hostOf(probeUrl);
  const targetAllowed = allowedHosts.includes(host);
  const probeAllowed = allowedHosts.includes(probeHost);
  if (!targetAllowed) {
    throw new Error(
      `Target "${host}" is not in ALLOWED_TARGETS — recon refuses off-allowlist hosts.`,
    );
  }

  const origin = new URL(target).origin;
  const headerSnapshots: Record<string, string>[] = [];
  const statuses: number[] = [];

  // Homepage (headers + body for link extraction).
  const home = await get(target);
  let homepageHtml: string | undefined;
  let negotiatedProtocol: string | undefined;
  if (!('error' in home)) {
    headerSnapshots.push(snapshot(home.res));
    statuses.push(home.res.status);
    homepageHtml = home.body;
    // Node's fetch does not expose ALPN; leave negotiatedProtocol to Alt-Svc.
    negotiatedProtocol = undefined;
  }

  // robots.txt + sitemap.xml (published surface only).
  const robotsRes = await get(`${origin}/robots.txt`);
  const robots = !('error' in robotsRes) && robotsRes.res.ok ? robotsRes.body : undefined;
  let sitemapXml: string | undefined;
  const sitemapUrl = `${origin}/sitemap.xml`;
  const sm = await get(sitemapUrl);
  if (!('error' in sm) && sm.res.ok) sitemapXml = sm.body;

  // Baseline: a few low-rate legitimate-probe samples.
  const baselineSamples: { ok: boolean; latencyMs: number; status?: number }[] = [];
  for (let i = 0; i < BASELINE_SAMPLES; i++) {
    const r = await get(probeUrl);
    if ('error' in r) baselineSamples.push({ ok: false, latencyMs: r.ms });
    else {
      headerSnapshots.push(snapshot(r.res));
      statuses.push(r.res.status);
      baselineSamples.push({ ok: r.res.ok, latencyMs: r.ms, status: r.res.status });
    }
  }

  return assembleReconReport({
    target,
    probeUrl,
    headerSnapshots,
    statuses,
    negotiatedProtocol,
    host,
    robots,
    sitemapXml,
    homepageHtml,
    baselineSamples,
    preflightInput: { ...flags, targetAllowed, probeAllowed },
  });
}
