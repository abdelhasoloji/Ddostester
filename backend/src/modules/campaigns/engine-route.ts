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
 * A run is a candidate for routing when it exceeds EITHER the built-in engine's
 * throughput ceiling (rate) OR its concurrency ceiling. The concurrency trigger
 * matters independently of rate: a high-concurrency in-process fan-out saturates
 * the Node event loop and starves the probe → a self-inflicted auto-kill with a
 * corrupted WRS (observed live at conc 400). Out-of-process engines run their
 * workers off our loop, so routing removes that failure mode.
 *
 * This picks the out-of-process engine a high-load campaign SHOULD use, or null
 * to keep the built-in engine. It is conservative — it only upgrades shapes the
 * candidate engine provably handles, so it never trades fidelity for a broken
 * run:
 *   - request flows (with or without correlation) → k6 (flow + correlation capable).
 *   - request flows (no correlation) → k6 (flow-capable).
 *   - simple floods (single URL ± phases, incl. POST) → vegeta (proven).
 *   - endpoint-mix / dataset / assertion / UA-rotation → keep built-in (the
 *     external adapters' support for these is not guaranteed; don't risk it).
 *
 * The caller still checks the chosen engine is actually available before using
 * it (falling back to built-in when the binary is absent).
 */
export function highRateEngineUpgrade(
  c: Pick<
    Campaign,
    'maxRps' | 'concurrency' | 'flow' | 'endpoints' | 'dataset' | 'assertion' | 'userAgents'
  >,
  ceilingRps: number,
  ceilingConcurrency = Number.POSITIVE_INFINITY,
): 'vegeta' | 'k6' | null {
  const overRate = c.maxRps > ceilingRps;
  const overConcurrency = c.concurrency > ceilingConcurrency;
  if (!overRate && !overConcurrency) return null;

  // Any request flow (with or without correlation) routes to k6: it is
  // flow-capable AND now correlation-capable (extracts a token from one response
  // and injects it into later steps), so authenticated journeys run at high rate
  // instead of being pinned to the ~150-rps built-in engine (P6).
  if (c.flow?.length) return 'k6';

  // Features only the built-in engine implements — never route these away, or a
  // step would silently lose its data-feeder / assertion / UA-rotation.
  const builtinOnly = !!c.dataset?.length || !!c.assertion || !!c.userAgents?.length;
  if (builtinOnly) return null;

  // A rate-capped flood (± phases) OR a recon-seeded endpoint mix: vegeta now
  // honours a multi-target endpoint set (see agents/vegeta.ts), so it delivers
  // the real rate for these too — where the built-in engine would cap ~150 rps.
  return 'vegeta';
}
