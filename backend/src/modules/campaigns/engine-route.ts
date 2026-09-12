import type { Campaign } from './model.js';

/**
 * High-rate engine routing (measurement-fidelity fix).
 *
 * The in-process built-in generator saturates its own event loop / shared
 * connection pool around ~150 rps and cannot push past it — so a step
 * configured at 300–800 rps silently delivers only ~140 rps and UNDER-tests the
 * target (observed live: 11 built-in steps all capped ~130–141 rps while two
 * out-of-process vegeta steps hit their 400 rps exactly). To measure the real
 * load, a high-rate step should run on an out-of-process engine.
 *
 * This picks the out-of-process engine a high-rate campaign SHOULD use, or null
 * to keep the built-in engine. It is conservative — it only upgrades shapes the
 * candidate engine provably handles, so it never trades fidelity for a broken
 * run:
 *   - correlation flows  → only the built-in engine supports them → keep built-in.
 *   - request flows (no correlation) → k6 (flow-capable).
 *   - simple floods (single URL ± phases, incl. POST) → vegeta (proven).
 *   - endpoint-mix / dataset / assertion / UA-rotation → keep built-in (the
 *     external adapters' support for these is not guaranteed; don't risk it).
 *
 * The caller still checks the chosen engine is actually available before using
 * it (falling back to built-in when the binary is absent).
 */
export function highRateEngineUpgrade(
  c: Pick<Campaign, 'maxRps' | 'flow' | 'endpoints' | 'dataset' | 'assertion' | 'userAgents'>,
  ceilingRps: number,
): 'vegeta' | 'k6' | null {
  if (!(c.maxRps > ceilingRps)) return null;

  const hasFlow = !!c.flow?.length;
  if (hasFlow) {
    const hasCorrelation = c.flow!.some((s) => s.extract != null);
    if (hasCorrelation) return null; // built-in only
    return 'k6'; // flow-capable, no correlation needed
  }

  const complex =
    !!c.endpoints?.length || !!c.dataset?.length || !!c.assertion || !!c.userAgents?.length;
  if (complex) return null; // keep built-in — external support not guaranteed

  return 'vegeta'; // simple rate-capped GET/POST flood (± phases)
}
