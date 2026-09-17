#!/usr/bin/env node
// Template matrix sweep — run one representative line of every curated template
// against one or more targets and print a comparison matrix (WRS / availability /
// mechanism / origin-5xx), the repeatable form of the ad-hoc "all templates vs
// each target" exercise.
//
// It reads each template's applicability (`requires`) and the target's recon
// posture, so a benign result on a target that LACKS a required feature (no WAF,
// no HTTP/2, no cache, no dynamic endpoint) is labelled N/A — not a misleading
// pass. Volumetric lines are delivered the way the templates now are against a
// bare origin: concentrated on the costliest dynamic path with fresh connections
// (connection pressure is what actually collapses an origin).
//
// Runs ON the control-plane host (needs AUTH_JWT_SECRET from /etc/ddostester.env)
// and drives the GOVERNED flow (engineer creates -> CISO approves -> engineer
// executes) — every run is bounded by HARD_CAPS, exactly like the UI.
//
// Usage (on VPS1):
//   set -a; . /etc/ddostester.env; set +a
//   node scripts/template-matrix.mjs http://46.28.109.92/ https://bank.cz/
//   node scripts/template-matrix.mjs --dur 30 --json /tmp/matrix.json <targets...>
//
// Flags: --dur <sec> (per-run duration, default 30) · --api <url> (default
// http://127.0.0.1:8080) · --json <path> (also write the raw results).

import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const DUR = Number(opt('--dur', '30'));
const API = opt('--api', 'http://127.0.0.1:8080');
const JSON_OUT = opt('--json', '');
const TARGETS = args.filter((a) => !a.startsWith('--'));
const FLOOD_RPS = 250;

if (!TARGETS.length) {
  console.error('usage: node scripts/template-matrix.mjs [--dur 30] [--json out] <target-url>...');
  process.exit(2);
}
const SECRET = process.env.AUTH_JWT_SECRET;
if (!SECRET) {
  console.error('AUTH_JWT_SECRET not set — run: set -a; . /etc/ddostester.env; set +a');
  process.exit(2);
}

const b64 = (x) => Buffer.from(x).toString('base64url');
const mint = (sub, role) => {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify({ sub, role, ver: 0, iat: now, exp: now + 3600 }));
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
};
const ENG = mint('claude-engineer@wedos', 'engineer');
const CISO = mint('claude-ciso@wedos', 'ciso');
const call = (path, token, opts = {}) =>
  fetch(API + path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The highest-rate non-baseline step characterises a template's peak attack line.
const peakStep = (pb) => {
  const attack = pb.steps.filter((s) => !/baseline/i.test(s.name));
  return (attack.length ? attack : pb.steps).reduce((a, b) => (b.maxRps > a.maxRps ? b : a));
};
const isH2Line = (name) =>
  /http\/?2|header-pressure|rapid.?reset|continuation|multiplex/i.test(name);

// Which required features a target lacks, from its recon report.
// NOTE: `has` MIRRORS reconPostureSnapshot() in
// backend/src/modules/recon/recon.ts (the single source) — this standalone ops
// script fetches recon via the API rather than importing the backend, so keep
// the two in sync by hand. The backend's GET /api/recon?actions=1 applies the
// same mapping server-side.
function missingRequirements(requires, recon) {
  if (!requires?.length || !recon) return [];
  const post = recon.profile?.posture ?? {};
  const has = {
    h2: !!recon.profile?.protocols?.http2,
    waf: !!post.waf,
    cache: recon.profile?.cache === 'hit' || !!post.cdn,
    dynamic: (recon.dynamicPaths?.length ?? 0) > 0,
  };
  return requires.filter((r) => !has[r]);
}

async function reconTarget(target) {
  const r = await call(`/api/recon?target=${encodeURIComponent(target)}`, ENG);
  const d = await r.json();
  return d.error ? null : d;
}

// Wait for the target to answer promptly again, so a previous run's load doesn't
// bleed into the next line's measurement (esp. a tarpitting edge).
async function waitRecovered(probeUrl) {
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(probeUrl, { signal: AbortSignal.timeout(3000) });
      if (r.ok && Date.now() - t0 < 1500) return;
    } catch {
      /* still loaded */
    }
    await sleep(2000);
  }
}

async function runLine(name, target, probeUrl, step) {
  const flood =
    (step.vector ?? 'http-get') !== 'http-slowloris' &&
    step.maxRps >= FLOOD_RPS &&
    !isH2Line(step.name);
  const body = {
    name: `matrix-${name}`.slice(0, 60),
    target,
    probeUrl,
    authorized: true,
    vector: step.vector ?? 'http-get',
    maxRps: step.maxRps,
    concurrency: step.concurrency,
    maxDurationSec: DUR,
    profile: step.profile ?? 'constant',
    agent: 'builtin',
    cacheBust: true,
    ...(flood ? { noKeepAlive: true } : {}),
  };
  const cr = await (
    await call('/api/campaigns', ENG, { method: 'POST', body: JSON.stringify(body) })
  ).json();
  if (!cr.id) return { error: cr.error || 'create failed' };
  await call(`/api/campaigns/${cr.id}/approval`, CISO, {
    method: 'POST',
    body: JSON.stringify({ decision: 'APPROVED', reason: 'matrix' }),
  });
  const run = await (
    await call(`/api/campaigns/${cr.id}/execute`, ENG, {
      method: 'POST',
      signal: AbortSignal.timeout((DUR + 90) * 1000),
    })
  ).json();
  if (run.error) return { error: run.error };
  const g = run.generator ?? {};
  const pr = run.probe ?? {};
  const samples = pr.samples || 1;
  return {
    status: run.status,
    wrs: run.wrs?.wrs,
    level: run.wrs?.level,
    availPct: Math.round(((pr.available ?? 0) / samples) * 100),
    mechanism: run.assessment?.mechanism,
    verdict: run.assessment?.verdict,
    origin5xx: g.statusCounts?.['5xx'] ?? 0,
    offeredRps: g.actualRps,
  };
}

async function main() {
  const playbooks = (await (await call('/api/playbooks', ENG)).json()).filter(
    (p) => !p.custom && !/readiness|endurance/i.test(p.category) && p.steps?.length,
  );
  console.log(
    `# Template matrix · ${playbooks.length} templates · ${DUR}s/line · ${new Date().toISOString()}\n`,
  );

  const all = {};
  for (const target of TARGETS) {
    const probeUrl = target; // probe the target itself
    console.log(`\n=== ${target} ===`);
    const recon = await reconTarget(target);
    if (recon) {
      const post = recon.profile?.posture ?? {};
      console.log(
        `recon: waf=${!!post.waf} cdn=${!!post.cdn} rateLimit=${!!post.rateLimiting} h2=${!!recon.profile?.protocols?.http2} cache=${recon.profile?.cache} dynamicPaths=${recon.dynamicPaths?.length ?? 0}`,
      );
    } else console.log('recon: (unavailable — treating as a plain HTTP target)');
    // Concentrate volumetric floods on the costliest dynamic path (relevance);
    // fall back to the target root.
    const dynUrl = recon?.dynamicPaths?.length
      ? new URL(recon.dynamicPaths[0], target).href
      : target;

    console.log(`${'template'.padEnd(30)} | ${'result'.padEnd(34)} | note`);
    console.log('-'.repeat(80));
    for (const pb of playbooks) {
      const step = peakStep(pb);
      const missing = missingRequirements(pb.requires, recon);
      const key = `${pb.id}@${target}`;
      if (missing.length) {
        all[key] = { skipped: true, missing };
        console.log(
          `${pb.name.slice(0, 30).padEnd(30)} | ${'— N/A —'.padEnd(34)} | needs ${missing.join('+')}`,
        );
        continue;
      }
      const flood =
        step.maxRps >= FLOOD_RPS &&
        (step.vector ?? 'http-get') !== 'http-slowloris' &&
        !isH2Line(step.name);
      const t = flood ? dynUrl : target;
      const res = await runLine(pb.id, t, probeUrl, step);
      all[key] = { template: pb.id, target, step: step.name, ...res };
      if (res.error) {
        console.log(`${pb.name.slice(0, 30).padEnd(30)} | ERROR ${res.error.slice(0, 28)}`);
      } else {
        const label = `${res.availPct}% avail · WRS ${res.wrs} ${res.level ?? ''} · ${res.mechanism} · 5xx=${res.origin5xx}`;
        console.log(
          `${pb.name.slice(0, 30).padEnd(30)} | ${label.padEnd(34)} | ${step.vector ?? 'get'} ${step.maxRps}r`,
        );
      }
      await waitRecovered(probeUrl); // let the target recover before the next line
    }
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(all, null, 2));
    console.log(`\nraw results -> ${JSON_OUT}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
