/**
 * SLO gate CLI (EPIC C). Runs ONE bounded campaign against an allowlisted lab
 * target on a running control plane, then applies the SLO gate and exits
 * non-zero on failure — so CI can block a release on a resilience regression.
 *
 * It creates NO new capability: the campaign goes through the same allowlist,
 * caps, attestation and approval as any other. The target must be in the
 * server's ALLOWED_TARGETS. Intended for a dedicated lab, invoked by
 * `.github/workflows/slo-gate.yml` (manual dispatch until a lab target exists).
 *
 * Config (env):
 *   SLO_GATE_BASE_URL           control plane base URL (default http://127.0.0.1:8080)
 *   SLO_GATE_TOKEN              bearer token (only if the server has auth enabled)
 *   SLO_GATE_TARGET            target URL (must be allowlisted)  [required]
 *   SLO_GATE_PROBE_URL         probe URL (default: the target)
 *   SLO_GATE_MAX_RPS / _CONCURRENCY / _MAX_DURATION_SEC   bounded load (defaults 50/10/30)
 *   SLO_MIN_WRS, SLO_MAX_P95_MS, SLO_MAX_ERROR_RATE_PCT,
 *   SLO_MIN_AVAILABILITY_PCT, SLO_MAX_ASSERTION_FAILURE_PCT,
 *   SLO_REGRESSION_TOLERANCE_PTS                          gate thresholds
 */

import {
  evaluateSloGate,
  metricsFromRun,
  sloGateConfigFromEnv,
} from '../modules/campaigns/slogate.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';

interface WrsSeriesLike {
  target: string;
  points: { wrs: number }[];
}

function env(name: string, fallback?: string): string {
  return process.env[name]?.trim() || fallback || '';
}
function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function main(): Promise<void> {
  const baseUrl = env('SLO_GATE_BASE_URL', 'http://127.0.0.1:8080').replace(/\/$/, '');
  const target = env('SLO_GATE_TARGET');
  if (!target) throw new Error('SLO_GATE_TARGET is required (must be allowlisted on the server)');
  const probeUrl = env('SLO_GATE_PROBE_URL', target);
  const token = env('SLO_GATE_TOKEN');
  const authHeader: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  const api = async <T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> => {
    // Only set content-type when there's a body — Fastify rejects an empty JSON body.
    const headers = body ? { ...authHeader, 'content-type': 'application/json' } : authHeader;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok)
      throw new Error(`${method} ${path} → ${res.status}: ${data.error ?? res.statusText}`);
    return data as T;
  };

  const hostOf = (u: string): string => {
    try {
      return new URL(u).hostname;
    } catch {
      return u;
    }
  };

  // Previous WRS for this target (for the regression check), before the new run.
  let previousWrs: number | undefined;
  try {
    const series = await api<WrsSeriesLike[]>('/api/wrs/history', 'GET');
    const s = series.find((x) => x.target === hostOf(target));
    previousWrs = s?.points.at(-1)?.wrs;
  } catch {
    /* history is best-effort */
  }

  // Bounded campaign through the normal allowlist / caps / approval path.
  const created = await api<{ id: string }>('/api/campaigns', 'POST', {
    name: `SLO gate ${new Date().toISOString()}`,
    target,
    probeUrl,
    vector: 'http-get',
    maxRps: intEnv('SLO_GATE_MAX_RPS', 50),
    concurrency: intEnv('SLO_GATE_CONCURRENCY', 10),
    maxDurationSec: intEnv('SLO_GATE_MAX_DURATION_SEC', 30),
    authorized: true,
    createdBy: 'ci-author',
  });
  await api(`/api/campaigns/${created.id}/approval`, 'POST', {
    approvedBy: 'ci-approver',
    decision: 'APPROVED',
  });
  const run = await api<CampaignRun>(`/api/campaigns/${created.id}/execute`, 'POST');

  const config = sloGateConfigFromEnv();
  const metrics = metricsFromRun(run);
  const verdict = evaluateSloGate(metrics, config, previousWrs);

  const line = (k: string, v: string | number): void => console.log(`  ${k.padEnd(16)} ${v}`);
  console.log(`SLO gate — ${hostOf(target)} (run ${run.runId}, status ${run.status})`);
  line(
    'WRS',
    `${run.wrs.wrs} (${run.wrs.level})${previousWrs != null ? ` — prev ${previousWrs}` : ''}`,
  );
  line('p95 latency', `${metrics.p95Ms} ms`);
  line('error rate', `${metrics.errorRatePct.toFixed(2)}%`);
  line('availability', `${metrics.availabilityPct.toFixed(1)}%`);
  console.log(`\nVerdict: ${verdict.verdict}`);
  if (!verdict.pass) {
    for (const r of verdict.reasons) console.log(`  ✗ ${r}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`SLO gate failed to run: ${(err as Error).message}`);
  process.exitCode = 1;
});
