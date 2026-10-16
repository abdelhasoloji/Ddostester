import type { DrsSequenceBinding } from '../drs/sequence.js';
import type { WrsBreakdown } from '../wrs/scoring.js';
import type {
  ScenarioPhase,
  RequestStep,
  ResponseAssertion,
  WeightedEndpoint,
} from '../../engine/types.js';
import type { AcceptanceCriteria, AcceptanceResult } from './acceptance.js';

export type { ScenarioPhase, RequestStep, ResponseAssertion, WeightedEndpoint };
export type { AcceptanceCriteria, AcceptanceResult };

/**
 * The only load vector supported by this control plane: bounded application
 * HTTP requests (GET/POST) toward an authorized target. The L3/L4 volumetric
 * vectors (floods, amplification) and L7 exhaustion vectors (Slowloris, RUDY,
 * XML bomb…) from TSD §5.2 are NOT implemented — see README.
 */
export type LoadVector = 'http-get' | 'http-post' | 'http-slowloris';

/**
 * A target feature a template's attack line needs to be meaningful:
 *   h2      – an HTTP/2 endpoint (multiplexing / header-pressure lines)
 *   waf     – a WAF / bot-management layer to evade
 *   cache   – an edge cache to bypass
 *   dynamic – an uncacheable origin endpoint to exhaust
 * When the target lacks the feature, a benign result is **N/A**, not resistance.
 */
export type TargetRequirement = 'h2' | 'waf' | 'cache' | 'dynamic';

/**
 * Compact snapshot of the target's recon posture captured at instantiation, so a
 * run report can mark which `requires` were N/A without re-running recon. Derived
 * by the single-source `reconPostureSnapshot()` in `modules/recon/recon.ts`.
 */
export interface ReconPostureSnapshot {
  h2: boolean;
  waf: boolean;
  cache: boolean;
  dynamic: boolean;
}

/**
 * The required features a target lacks, given its recon posture — i.e. the
 * requirements that are N/A for it. Empty when nothing is required, no posture
 * was captured, or the target satisfies everything.
 */
export function missingRequirements(
  requires: TargetRequirement[] | undefined,
  posture: ReconPostureSnapshot | undefined,
): TargetRequirement[] {
  if (!requires?.length || !posture) return [];
  return requires.filter((r) => !posture[r]);
}

export type CampaignStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'KILLED_AUTO'
  | 'KILLED_MANUAL'
  // Terminal: an unrun campaign (pending or approved) cancelled before execution
  // — distinct from REJECTED (an approval decision) and the KILLED_* run outcomes.
  | 'CANCELLED';

export interface CampaignInput {
  drsMode?: import('../drs/model.js').DrsMode;
  drsProfileId?: string;
  /** Explicit enrolled device selection; absent preserves the three-agent group default. */
  fleetDeviceIds?: string[];
  /** Optional deterministic synthetic HTTP sensor journey, compiled before approval. */
  iotProfile?: import('../../engine/iot-profile.js').IoTProfile;
  name: string;
  description?: string;
  /** Target URL (must be in the allowlist). */
  target: string;
  vector: LoadVector;
  body?: string;
  headers?: Record<string, string>;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  /** Probed endpoint to measure impact (often the target itself). */
  probeUrl: string;
  /**
   * Optional independent reference endpoint (a canary / second vantage) polled
   * alongside the target probe but with NO kill authority. It lets a run tell
   * "the target fell over" from "we can't reach anything" (our own egress is
   * saturated, or a broader outage): if the target degrades while the reference
   * stays healthy, the outage is target-attributed; if both degrade together,
   * the verdict is flagged inconclusive. Must be http/https and in the
   * allowlist, like the target/probe. Absent = no corroboration.
   */
  referenceUrl?: string;
  /**
   * Where the availability probe is measured from. 'local' (default) probes from
   * the control plane; 'remote' probes via the configured read-only probe agent
   * on another host (e.g. VPS2 over the tailnet), so the probe uses a different
   * source IP than the load generator — needed when the target rate-limits by
   * source IP. 'remote' requires the server to have a probe agent configured
   * (PROBE_AGENT_URL / PROBE_AGENT_TOKEN); a run fails closed otherwise.
   */
  probeVantage?: 'local' | 'remote';
  createdBy: string;
  /** The author attests the target is authorized (internal WEDOS / written mandate). */
  authorized: boolean;
  /**
   * Scheduled execution window (ISO). If set, the campaign — once APPROVED — is
   * executed automatically by the scheduler at this time (CAM-01). Absent =
   * manual execution.
   */
  scheduledAt?: string;
  /**
   * Optional bounded load scenario (GEN-03): sequential phases (ramp-up,
   * waves…). Absent = constant load (maxRps/maxDurationSec).
   */
  scenario?: ScenarioPhase[];
  /**
   * Optional load engine id (e.g. 'builtin', 'k6', 'vegeta'). Absent = the
   * server default agent. All engines produce bounded HTTP load only.
   */
  agent?: string;
  /**
   * Optional bounded request flow (L7 journey): an ordered list of steps, each
   * an HTTP request to an allowlisted host, optionally with think-time. Absent =
   * a single request to `target`. The caps still bound the total request rate.
   */
  flow?: RequestStep[];
  /**
   * Optional weighted endpoint mix (built-in engine only): spread the load over
   * several URLs by weight instead of a single target. Mutually exclusive with
   * `flow`. The caps still bound the total request rate.
   */
  endpoints?: WeightedEndpoint[];
  /**
   * Optional User-Agent rotation (built-in engine only): each request picks a
   * UA at random from this list — realistic client diversity for testing
   * signature-based mitigation. A benign header change, not an attack mechanic.
   */
  userAgents?: string[];
  /**
   * Optional data-driven feeder (built-in engine only): dataset rows whose
   * columns are substituted into URL/body/headers via `{{column}}`.
   */
  dataset?: Record<string, string>[];
  /**
   * Cache-busting: append a unique query param to every request so an edge/CDN
   * or page cache can't serve a stored response — each request is forced to the
   * origin. Works on the built-in engine, k6 and vegeta (unlike UA rotation, it
   * does NOT pin the run to the built-in engine). Turns a trivially-cached GET
   * flood into real origin pressure. Benign, still rate-capped and allowlisted.
   */
  cacheBust?: boolean;
  /**
   * Disable HTTP keep-alive — a fresh connection per request, to pressure the
   * origin's connection-accept path (handshake/accept queue). Works on the
   * built-in engine, k6 and vegeta. Benign, rate-capped, allowlisted.
   */
  noKeepAlive?: boolean;
  /**
   * Parallel generation (P4, mono-box): spread the load over N concurrent
   * generator processes on the host, each at rate/N, to break a single process's
   * ceiling. Vegeta engine. Total rate unchanged and still HARD_CAPS-bounded.
   */
  parallelism?: number;
  /**
   * Closed-loop rate calibration (GEN-1): when true, the run first fires a short
   * pre-flight burst on its real engine + target to measure the rate it can
   * actually deliver, then grades at that rate instead of an aspirational one it
   * would silently under-deliver (which the assessment marks INCONCLUSIVE).
   * Calibration only ever LOWERS the offered rate, never raises it above the
   * requested one, and stays bounded/allowlisted/capped like any run. The applied
   * vs requested rate is recorded on the run so the report is honest about it.
   */
  calibrate?: boolean;
  /**
   * Optional SLO acceptance criteria. When set, each run gets a PASS/FAIL
   * verdict against these thresholds (latency, error rate, availability, WRS).
   */
  acceptance?: AcceptanceCriteria;
  /** Optional per-response assertion (built-in engine only). */
  assertion?: ResponseAssertion;
  /** Assessment suite linkage (set when created from a playbook). */
  suiteId?: string;
  suiteName?: string;
  suiteOrder?: number;
  /**
   * Target features the source template needs to be meaningful (copied from
   * `Playbook.requires` at instantiation). Surfaced in the run report so a
   * benign result against a target lacking the feature reads as N/A.
   */
  requires?: TargetRequirement[];
  /**
   * The target's recon posture captured at instantiation, so the report can
   * decide which `requires` were N/A without re-running recon. Absent for
   * campaigns created before this field existed (report falls back to
   * `run.posture`).
   */
  reconPosture?: ReconPostureSnapshot;
  /**
   * Optional recurrence: once APPROVED, re-run the campaign every
   * `intervalMin` minutes. Recurrence only fires while the approval is valid
   * (24 h) and, if set, before `until` — so it never bypasses the approval
   * window or separation of duties. Absent = single run.
   */
  recurrence?: Recurrence;
}

/** A recurring schedule bounded by the approval window (CAM-01). */
export interface Recurrence {
  /** Minutes between runs (>= MIN_RECURRENCE_MIN). */
  intervalMin: number;
  /** Optional ISO end time; recurrence also stops when approval expires. */
  until?: string;
}

export interface Campaign extends CampaignInput {
  drsSequence?: DrsSequenceBinding;
  /** Server-captured client scope for an offline prototype; never a target grant. */
  clientWorkspace?: {
    id: string;
    revision: number;
    hash: string | null;
    profile: import('../infrastructure/clients.js').ClientProfile;
  };
  drsDocument?: import('../drs/model.js').DrsDocument;
  id: string;
  status: CampaignStatus;
  createdAt: string;
  approvedBy?: string;
  approvalReason?: string;
  approvalExpiresAt?: string;
  /** Mandatory CISO sign-off (dual control) — set once a CISO co-signs an
   *  officer-approved campaign. When the CISO gate is on, execution needs both. */
  cisoApprovedBy?: string;
  cisoApprovedAt?: string;
  wrs?: WrsBreakdown;
  /** SLO verdict of the latest run (set alongside wrs/runId). */
  acceptanceResult?: AcceptanceResult;
  runId?: string;
  /** Why the latest run ended as it did (set for a kill), mirrored from the run. */
  statusDetail?: string;
  /**
   * Wall-clock of the latest run's load generator, mirrored from the run at
   * settle time so the campaigns list can show start/end/duration without
   * loading every run. Absent until the campaign has run at least once.
   */
  startedAt?: string;
  finishedAt?: string;
  durationSec?: number;
  /**
   * Archived campaigns are hidden from the default campaigns view (an
   * organisational state, orthogonal to the run lifecycle — a COMPLETED or
   * CANCELLED campaign can be archived and un-archived). Never blocks history,
   * reports or audit.
   */
  archived?: boolean;
}

// Safety caps and the recurrence floor are defined once in config/limits.ts
// (the single source of truth) and re-exported here for backward compatibility
// so existing importers keep working. Do not redefine them here.
export { HARD_CAPS, MIN_RECURRENCE_MIN } from '../../config/limits.js';
export type { HardCaps } from '../../config/limits.js';
