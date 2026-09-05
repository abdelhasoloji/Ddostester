import type { WrsBreakdown } from '../wrs/scoring.js';
import type { ScenarioPhase } from '../../engine/types.js';

export type { ScenarioPhase };

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
}

export interface Campaign extends CampaignInput {
  id: string;
  status: CampaignStatus;
  createdAt: string;
  approvedBy?: string;
  approvalReason?: string;
  approvalExpiresAt?: string;
  wrs?: WrsBreakdown;
  runId?: string;
}

/** Hard caps, non-bypassable via the API (defense in depth). */
export const HARD_CAPS = {
  maxRps: 2000,
  maxConcurrency: 500,
  maxDurationSec: 900, // absolute time-based timeout (15 min, TSD §5.1)
} as const;
