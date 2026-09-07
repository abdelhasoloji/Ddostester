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
export type LoadVector = 'http-get' | 'http-post';

export type CampaignStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'KILLED_AUTO'
  | 'KILLED_MANUAL';

export interface CampaignInput {
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
  id: string;
  status: CampaignStatus;
  createdAt: string;
  approvedBy?: string;
  approvalReason?: string;
  approvalExpiresAt?: string;
  wrs?: WrsBreakdown;
  /** SLO verdict of the latest run (set alongside wrs/runId). */
  acceptanceResult?: AcceptanceResult;
  runId?: string;
  /** Why the latest run ended as it did (set for a kill), mirrored from the run. */
  statusDetail?: string;
}

// Safety caps and the recurrence floor are defined once in config/limits.ts
// (the single source of truth) and re-exported here for backward compatibility
// so existing importers keep working. Do not redefine them here.
export { HARD_CAPS, MIN_RECURRENCE_MIN } from '../../config/limits.js';
export type { HardCaps } from '../../config/limits.js';
