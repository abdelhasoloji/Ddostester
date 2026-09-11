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

// ── Probe / kill-switch thresholds ────────────────────────────────────────
// The legitimate probe (backend/src/modules/probe/probe.ts) measures the target
// and drives the auto kill switch. Every threshold it uses lives here, not as a
// magic number in the probe, and each one is overridable by an env var so an
// operator can tune sensitivity per deployment without a code change. These are
// SAFETY thresholds: they decide when a run is stopped to protect the target, so
// treat loosening them (e.g. raising `windowKillAvailPct` down toward 0, or
// pushing `autoKillUnavailableMs` up) as a change to the safety envelope.

export type ProbeLimits = {
  /** Poll cadence (ms) between probe checks. */
  intervalMs: number;
  /** Per-check request timeout (ms); a check exceeding it counts as unavailable. */
  timeoutMs: number;
  /** Level 1a — consecutive unavailability (ms) that trips the auto kill switch. */
  autoKillUnavailableMs: number;
  /** Sliding window (ms) used for the availability/latency health verdict. */
  windowMs: number;
  /** Minimum samples in a full window before a windowed verdict is trusted. */
  windowMinSamples: number;
  /** Level 1b — availability (%) over a FULL window below this trips the kill
   *  switch. This catches a *flapping* target (up/down/up) that never accrues a
   *  full run of consecutive failures, which the level-1a rule alone misses. */
  windowKillAvailPct: number;
  /** Availability (%) over the window below this marks the run 'degraded' (a
   *  graduated warning surfaced to the operator BEFORE any hard kill). */
  degradedAvailPct: number;
  /** Level 1c (opt-in) — sustained window p95 latency (ms) above this trips the
   *  kill switch, protecting a target that is technically up but on its knees.
   *  0 disables it (the default: never kill on latency without explicit intent). */
  latencyKillMs: number;
  /** Window p95 latency (ms) above this marks the run 'degraded'. 0 disables. */
  degradedLatencyMs: number;
};

/** Documented, frozen defaults. Env vars override individual fields at startup. */
export const PROBE_LIMITS: Readonly<ProbeLimits> = Object.freeze({
  intervalMs: 5000,
  timeoutMs: 5000,
  autoKillUnavailableMs: 30_000,
  windowMs: 30_000,
  windowMinSamples: 4,
  windowKillAvailPct: 50,
  degradedAvailPct: 80,
  latencyKillMs: 0,
  degradedLatencyMs: 0,
});

/** Resolve the effective probe limits, applying env overrides over the defaults.
 *  A missing/invalid/negative env value falls back to the default (never throws). */
export function probeLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ProbeLimits {
  const num = (v: string | undefined, dflt: number): number => {
    if (v === undefined) return dflt;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    intervalMs: num(env.PROBE_INTERVAL_MS, PROBE_LIMITS.intervalMs),
    timeoutMs: num(env.PROBE_TIMEOUT_MS, PROBE_LIMITS.timeoutMs),
    autoKillUnavailableMs: num(env.PROBE_AUTOKILL_MS, PROBE_LIMITS.autoKillUnavailableMs),
    windowMs: num(env.PROBE_WINDOW_MS, PROBE_LIMITS.windowMs),
    windowMinSamples: num(env.PROBE_WINDOW_MIN_SAMPLES, PROBE_LIMITS.windowMinSamples),
    windowKillAvailPct: num(env.PROBE_WINDOW_KILL_AVAIL_PCT, PROBE_LIMITS.windowKillAvailPct),
    degradedAvailPct: num(env.PROBE_DEGRADED_AVAIL_PCT, PROBE_LIMITS.degradedAvailPct),
    latencyKillMs: num(env.PROBE_LATENCY_KILL_MS, PROBE_LIMITS.latencyKillMs),
    degradedLatencyMs: num(env.PROBE_DEGRADED_LATENCY_MS, PROBE_LIMITS.degradedLatencyMs),
  };
}

/**
 * Conservative detection/mitigation timings (seconds) used to estimate the WRS
 * when no real protection source reports the true numbers. Named here rather
 * than inlined as magic numbers in the runner; a run whose WRS is built from
 * these is flagged `estimated` in the UI/report.
 */
export const ESTIMATED_TIMINGS = Object.freeze({
  /** Auto-killed: the probe saw the target fall over, so detection was slow. */
  autoKill: Object.freeze({ detectionTimeSec: 30, mitigationTimeSec: 60 }),
  /** Otherwise: the target held; assume prompt detection/mitigation. */
  held: Object.freeze({ detectionTimeSec: 10, mitigationTimeSec: 20 }),
});

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
/**
 * Max total steps when several templates are composed into one suite
 * (`POST /api/suites/compose`). Bounds the length of an operator-assembled
 * sequence; each composed campaign is still capped individually.
 */
export const MAX_COMPOSITE_STEPS = 24;
