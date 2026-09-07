/**
 * limits.ts — THE single source of truth for every safety cap and run-shape
 * bound in ShieldTest.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Why this file exists
 * ──────────────────────────────────────────────────────────────────────────
 * These constants define how much a single authorized run can do. They are the
 * safety envelope of the whole platform. To keep control of them, they live in
 * exactly ONE place: here. Every other module (campaign model, engine, custom
 * playbooks) and the `/health` endpoint re-export or read from this file — none
 * of them defines its own copy. The frontend does not hardcode them either; it
 * reads `hardCaps` from `/health`.
 *
 * Rules for changing anything in this file:
 *   1. This is a security boundary. Raising a cap widens the blast radius of an
 *      authorized run — treat any increase as a security change (review + the
 *      audit trail), never a convenience tweak.
 *   2. `HARD_CAPS` is enforced server-side and is non-bypassable via the API
 *      (defense in depth). It is never weakened per-campaign, per-playbook or
 *      per-request. See docs/safeguards.md and drs-validation-policy.md §2.
 *   3. Add new bounds here, not scattered across modules. If you need a limit,
 *      define it in this file and import it.
 */

/**
 * Hard caps on a single run's load, non-bypassable via the API (defense in
 * depth). The one boundary that bounds every campaign, playbook step and
 * validation job. Frozen so it cannot be mutated at runtime.
 */
export const HARD_CAPS = Object.freeze({
  /** Requests per second, absolute ceiling. */
  maxRps: 2000,
  /** Concurrent in-flight requests, absolute ceiling. */
  maxConcurrency: 500,
  /** Absolute time-based timeout (15 min, TSD §5.1). */
  maxDurationSec: 900,
} as const);

/** The shape `/health` exposes and the frontend consumes (see app.ts, api.ts). */
export type HardCaps = { maxRps: number; maxConcurrency: number; maxDurationSec: number };

/**
 * Operational limits: the caps ShieldTest actually enforces, which a CISO may
 * tighten (or raise back up to the ceiling) from the UI. They are NEVER allowed
 * to exceed `HARD_CAPS` — that frozen ceiling is the absolute safety boundary,
 * immutable from any interface, so a UI edit or a compromised account can never
 * turn ShieldTest into an unbounded tool. `clampToCeiling` enforces this on
 * every write; the effective cap is always `min(operational, HARD_CAPS)`.
 */
export type OperationalLimits = HardCaps;

/**
 * Clamp a candidate operational-limits object into the valid range: every value
 * is coerced to an integer within [1, HARD_CAPS.<field>]. A non-finite or
 * missing field falls back to the ceiling. The result can never exceed the
 * frozen ceiling — that is the whole point.
 */
export function clampToCeiling(candidate: Partial<HardCaps> | undefined): HardCaps {
  const clamp = (v: unknown, ceiling: number): number => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return ceiling;
    return Math.min(ceiling, Math.max(1, n));
  };
  return {
    maxRps: clamp(candidate?.maxRps, HARD_CAPS.maxRps),
    maxConcurrency: clamp(candidate?.maxConcurrency, HARD_CAPS.maxConcurrency),
    maxDurationSec: clamp(candidate?.maxDurationSec, HARD_CAPS.maxDurationSec),
  };
}

/** True iff every field is a valid integer within [1, ceiling] (no clamping applied). */
export function withinCeiling(candidate: Partial<HardCaps> | undefined): boolean {
  if (!candidate) return false;
  const ok = (v: unknown, ceiling: number): boolean =>
    Number.isInteger(v) && (v as number) >= 1 && (v as number) <= ceiling;
  return (
    ok(candidate.maxRps, HARD_CAPS.maxRps) &&
    ok(candidate.maxConcurrency, HARD_CAPS.maxConcurrency) &&
    ok(candidate.maxDurationSec, HARD_CAPS.maxDurationSec)
  );
}

/** Minimum spacing between recurring runs (avoids hammering a target). */
export const MIN_RECURRENCE_MIN = 15;

// ── Run-shape input bounds (defense in depth) ─────────────────────────────
// How large the *shape* of one run may be. These bound what an operator can
// submit; they do not raise HARD_CAPS.

/** Max steps in a request flow. */
export const MAX_FLOW_STEPS = 20;
/** Max per-step think time (ms) in a flow. */
export const MAX_THINK_MS = 30_000;
/** Max distinct endpoints in a traffic mix. */
export const MAX_ENDPOINTS = 20;
/** Max distinct User-Agent strings in a rotation set. */
export const MAX_USER_AGENTS = 50;
/** Max rows in a data-driven feeder dataset. */
export const MAX_DATASET_ROWS = 1000;

// ── Custom-playbook bounds ────────────────────────────────────────────────

/** Max steps in a (curated or custom) assessment playbook. */
export const MAX_PLAYBOOK_STEPS = 12;
/** Max custom request headers per playbook step. */
export const MAX_PLAYBOOK_HEADERS = 10;
