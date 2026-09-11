import { randomUUID } from 'node:crypto';
import { HARD_CAPS, MIN_RECURRENCE_MIN } from './model.js';
import type { HardCaps } from '../../config/limits.js';
import type { Campaign, CampaignInput, CampaignStatus } from './model.js';
import {
  HTTP_METHODS,
  MAX_DATASET_ROWS,
  MAX_ENDPOINTS,
  MAX_FLOW_STEPS,
  MAX_THINK_MS,
  MAX_USER_AGENTS,
} from '../../engine/types.js';
import { flowUsesCorrelation } from '../../engine/correlation.js';

const EXTRACT_SOURCES = ['json', 'header', 'regex'];

export class CampaignError extends Error {}

function assertHostAllowed(rawUrl: string, allowedHosts: string[], label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CampaignError(`${label}: invalid URL (${rawUrl}).`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new CampaignError(`${label}: only http/https are supported.`);
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new CampaignError(
      `${label}: host "${parsed.hostname}" is not in the allowlist. ` +
        `Only pre-approved targets (internal / mandated) are accepted.`,
    );
  }
}

/**
 * Validates and creates a campaign with status PENDING_APPROVAL. Applies the
 * safeguards: attested authorization, target and probe in the allowlist,
 * intensity/duration bounded by HARD_CAPS.
 */
/** Minimal agent metadata used to validate a campaign's chosen engine. */
export interface AgentChoice {
  id: string;
  multiPhase: boolean;
  flowCapable: boolean;
  correlationCapable: boolean;
}

export function createCampaign(
  input: CampaignInput,
  allowedHosts: string[],
  agents?: AgentChoice[],
  // The effective caps to enforce. Defaults to the immutable ceiling; the app
  // passes the CISO-set operational limits (always ≤ ceiling), so a campaign can
  // never exceed either the ceiling or the current operational limit.
  caps: HardCaps = HARD_CAPS,
): Campaign {
  if (!input.authorized) {
    throw new CampaignError(
      'The campaign must be attested as authorized (authorized=true) by its author.',
    );
  }
  if (!input.name?.trim()) throw new CampaignError('Campaign name is required.');
  if (!input.createdBy?.trim()) throw new CampaignError('Author (createdBy) is required.');

  assertHostAllowed(input.target, allowedHosts, 'Target');
  assertHostAllowed(input.probeUrl, allowedHosts, 'Probe');
  // The optional reference vantage is a read-only health check; hold it to the
  // same allowlist as the target/probe so it can never become an unbounded GET.
  if (input.referenceUrl) assertHostAllowed(input.referenceUrl, allowedHosts, 'Reference');

  // Caps are whole numbers: rps, concurrent workers and seconds are counts, so a
  // fractional value is a client error, not a bounded-but-odd request.
  if (!Number.isInteger(input.maxRps) || input.maxRps < 1 || input.maxRps > caps.maxRps) {
    throw new CampaignError(`maxRps must be an integer within [1, ${caps.maxRps}].`);
  }
  if (
    !Number.isInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > caps.maxConcurrency
  ) {
    throw new CampaignError(`concurrency must be an integer within [1, ${caps.maxConcurrency}].`);
  }
  if (
    !Number.isInteger(input.maxDurationSec) ||
    input.maxDurationSec < 1 ||
    input.maxDurationSec > caps.maxDurationSec
  ) {
    throw new CampaignError(
      `maxDurationSec must be an integer within [1, ${caps.maxDurationSec}].`,
    );
  }

  if (input.scheduledAt !== undefined && Number.isNaN(Date.parse(input.scheduledAt))) {
    throw new CampaignError('scheduledAt: invalid ISO date.');
  }

  if (input.recurrence) {
    const { intervalMin, until } = input.recurrence;
    if (!Number.isFinite(intervalMin) || !Number.isInteger(intervalMin)) {
      throw new CampaignError('recurrence.intervalMin must be an integer number of minutes.');
    }
    if (intervalMin < MIN_RECURRENCE_MIN) {
      throw new CampaignError(`recurrence.intervalMin must be >= ${MIN_RECURRENCE_MIN} minutes.`);
    }
    if (until !== undefined) {
      const t = Date.parse(until);
      if (Number.isNaN(t)) throw new CampaignError('recurrence.until: invalid ISO date.');
      if (t <= Date.now()) throw new CampaignError('recurrence.until must be in the future.');
    }
  }

  if (input.scenario) {
    if (input.scenario.length < 1 || input.scenario.length > 12) {
      throw new CampaignError('A scenario must have between 1 and 12 phases.');
    }
    let totalDur = 0;
    for (const p of input.scenario) {
      if (!Number.isInteger(p.maxRps) || p.maxRps < 1 || p.maxRps > caps.maxRps) {
        throw new CampaignError(`Phase: maxRps must be an integer within [1, ${caps.maxRps}].`);
      }
      if (!Number.isInteger(p.durationSec) || p.durationSec < 1) {
        throw new CampaignError('Phase: duration must be an integer ≥ 1 s.');
      }
      totalDur += p.durationSec;
    }
    if (totalDur > caps.maxDurationSec) {
      throw new CampaignError(`Total scenario duration ≤ ${caps.maxDurationSec}s.`);
    }
    // Normalize the aggregated fields for display/metrics.
    input.maxRps = Math.max(...input.scenario.map((p) => p.maxRps));
    input.maxDurationSec = totalDur;
  }

  if (input.flow) {
    if (input.flow.length < 1 || input.flow.length > MAX_FLOW_STEPS) {
      throw new CampaignError(`A flow must have between 1 and ${MAX_FLOW_STEPS} steps.`);
    }
    for (const step of input.flow) {
      if (!HTTP_METHODS.includes(step.method)) {
        throw new CampaignError(`Flow step: unsupported method "${step.method}".`);
      }
      assertHostAllowed(step.url, allowedHosts, 'Flow step');
      if (step.thinkMs != null && (step.thinkMs < 0 || step.thinkMs > MAX_THINK_MS)) {
        throw new CampaignError(`Flow step: thinkMs must be within [0, ${MAX_THINK_MS}].`);
      }
      if (step.extract) {
        if (!step.extract.name?.trim()) {
          throw new CampaignError('Flow step: extract.name is required.');
        }
        if (!EXTRACT_SOURCES.includes(step.extract.from)) {
          throw new CampaignError(
            `Flow step: extract.from must be one of ${EXTRACT_SOURCES.join(', ')}.`,
          );
        }
        if (!step.extract.expr?.trim()) {
          throw new CampaignError('Flow step: extract.expr is required.');
        }
      }
    }
  }

  if (input.acceptance) {
    const a = input.acceptance;
    if (a.maxP95Ms != null && a.maxP95Ms < 0) {
      throw new CampaignError('acceptance.maxP95Ms must be >= 0.');
    }
    const pct = (v: number | undefined, name: string): void => {
      if (v != null && (v < 0 || v > 100)) {
        throw new CampaignError(`acceptance.${name} must be within [0, 100].`);
      }
    };
    pct(a.maxErrorRatePct, 'maxErrorRatePct');
    pct(a.minAvailabilityPct, 'minAvailabilityPct');
    pct(a.minWrs, 'minWrs');
    pct(a.maxAssertionFailurePct, 'maxAssertionFailurePct');
  }

  if (input.endpoints) {
    if (input.flow?.length) {
      throw new CampaignError('Use either a request flow or an endpoint mix, not both.');
    }
    if (input.endpoints.length < 1 || input.endpoints.length > MAX_ENDPOINTS) {
      throw new CampaignError(`An endpoint mix must have between 1 and ${MAX_ENDPOINTS} entries.`);
    }
    let totalWeight = 0;
    for (const ep of input.endpoints) {
      if (ep.method && !HTTP_METHODS.includes(ep.method)) {
        throw new CampaignError(`Endpoint: unsupported method "${ep.method}".`);
      }
      assertHostAllowed(ep.url, allowedHosts, 'Endpoint');
      if (ep.weight != null && (!Number.isFinite(ep.weight) || ep.weight < 0)) {
        throw new CampaignError('Endpoint: weight must be a number >= 0.');
      }
      totalWeight += ep.weight == null ? 1 : ep.weight;
    }
    if (totalWeight <= 0) {
      throw new CampaignError('Endpoint mix: at least one weight must be > 0.');
    }
    if (input.agent && input.agent !== 'builtin') {
      throw new CampaignError('An endpoint mix requires the built-in engine.');
    }
  }

  if (input.userAgents) {
    if (input.userAgents.length < 1 || input.userAgents.length > MAX_USER_AGENTS) {
      throw new CampaignError(`User-Agent rotation must have between 1 and ${MAX_USER_AGENTS}.`);
    }
    if (input.userAgents.some((ua) => !ua.trim())) {
      throw new CampaignError('User-Agent rotation: entries must be non-empty.');
    }
    if (input.agent && input.agent !== 'builtin') {
      throw new CampaignError('User-Agent rotation requires the built-in engine.');
    }
  }

  if (input.dataset) {
    if (input.dataset.length < 1 || input.dataset.length > MAX_DATASET_ROWS) {
      throw new CampaignError(`Dataset must have between 1 and ${MAX_DATASET_ROWS} rows.`);
    }
    if (input.dataset.some((row) => typeof row !== 'object' || row === null)) {
      throw new CampaignError('Dataset: each row must be an object of string values.');
    }
    if (input.agent && input.agent !== 'builtin') {
      throw new CampaignError('A data-driven feeder requires the built-in engine.');
    }
  }

  if (input.assertion) {
    const { status, bodyContains } = input.assertion;
    if (status == null && !bodyContains?.trim()) {
      throw new CampaignError('assertion: set a status and/or bodyContains.');
    }
    if (status != null && (status < 100 || status > 599)) {
      throw new CampaignError('assertion.status must be within [100, 599].');
    }
    // Assertions are evaluated by the built-in engine only.
    if (input.agent && input.agent !== 'builtin') {
      throw new CampaignError('Response assertions require the built-in engine.');
    }
  }

  // Validate the chosen load engine when the caller supplies the agent list.
  if (input.agent && agents) {
    const chosen = agents.find((a) => a.id === input.agent);
    if (!chosen) {
      throw new CampaignError(`Unknown load engine "${input.agent}".`);
    }
    if (input.scenario && input.scenario.length > 1 && !chosen.multiPhase) {
      throw new CampaignError(
        `Load engine "${input.agent}" does not support multi-phase scenarios — ` +
          `use a constant profile or choose k6/vegeta/builtin.`,
      );
    }
    if (input.flow && input.flow.length > 0 && !chosen.flowCapable) {
      throw new CampaignError(
        `Load engine "${input.agent}" does not support multi-step flows — ` +
          `choose builtin/k6/jmeter/gatling/locust.`,
      );
    }
    if (flowUsesCorrelation(input.flow) && !chosen.correlationCapable) {
      throw new CampaignError(
        `Load engine "${input.agent}" does not support flow correlation ` +
          `({{vars}} / extract) — use the built-in engine.`,
      );
    }
  }

  return {
    ...input,
    id: randomUUID(),
    status: 'PENDING_APPROVAL',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Approval workflow (TSD §5.1 CAM-02): the Security Officer approves or rejects.
 * Approval is valid for 24h. Separation of duties: the approver must differ from
 * the author.
 */
export function approveCampaign(
  campaign: Campaign,
  approvedBy: string,
  decision: 'APPROVED' | 'REJECTED',
  reason?: string,
): Campaign {
  if (campaign.status !== 'PENDING_APPROVAL') {
    throw new CampaignError(`Campaign is not approvable (status ${campaign.status}).`);
  }
  if (!approvedBy?.trim()) throw new CampaignError('Approver is required.');
  if (approvedBy === campaign.createdBy) {
    throw new CampaignError('Separation of duties: approver ≠ author.');
  }
  if (decision === 'REJECTED' && !reason?.trim()) {
    throw new CampaignError('A rejection must include a reason.');
  }

  const approvalExpiresAt =
    decision === 'APPROVED' ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined;

  return { ...campaign, status: decision, approvedBy, approvalReason: reason, approvalExpiresAt };
}

/**
 * Cancels an unrun campaign (CAM — annulation): a PENDING_APPROVAL or APPROVED
 * campaign that will no longer run is moved to the terminal CANCELLED state.
 * Refuses a running or already-terminal campaign (use the kill switch for a run
 * in flight). Administrative, not an approval decision, so no author≠approver
 * check — the author can cancel their own queued campaign.
 */
export function cancelCampaign(campaign: Campaign, reason?: string): Campaign {
  if (campaign.status !== 'PENDING_APPROVAL' && campaign.status !== 'APPROVED') {
    throw new CampaignError(
      `Only a pending or approved campaign can be cancelled (status ${campaign.status}). ` +
        `Use the kill switch for a run in flight.`,
    );
  }
  return {
    ...campaign,
    status: 'CANCELLED',
    statusDetail: reason?.trim() || 'Cancelled before execution',
  };
}

/**
 * Archive / un-archive a campaign — an organisational state that only hides it
 * from the default list; it never changes the run lifecycle, history or audit.
 * Refuses to archive a campaign whose run is in flight (archive it once settled).
 */
export function setArchived(campaign: Campaign, archived: boolean): Campaign {
  if (archived && campaign.status === 'RUNNING') {
    throw new CampaignError('Cannot archive a running campaign — wait for the run to settle.');
  }
  if (Boolean(campaign.archived) === archived) return campaign;
  return { ...campaign, archived };
}

/**
 * Mandatory CISO sign-off (dual control): a CISO co-signs a campaign the officer
 * has already approved. Separation of duties across all three roles — the CISO
 * signer must differ from both the author and the officer approver.
 */
export function cisoApproveCampaign(campaign: Campaign, cisoBy: string): Campaign {
  if (campaign.status !== 'APPROVED') {
    throw new CampaignError(
      `CISO sign-off requires an officer-approved campaign (status ${campaign.status}).`,
    );
  }
  if (!cisoBy?.trim()) throw new CampaignError('CISO approver is required.');
  if (cisoBy === campaign.createdBy) {
    throw new CampaignError('Separation of duties: the CISO approver ≠ the author.');
  }
  if (campaign.approvedBy && cisoBy === campaign.approvedBy) {
    throw new CampaignError('Separation of duties: the CISO approver ≠ the officer approver.');
  }
  return { ...campaign, cisoApprovedBy: cisoBy, cisoApprovedAt: new Date().toISOString() };
}

/**
 * Checks a campaign is executable now (approved, not expired). When
 * `requireCiso` is set (the CISO gate — the posture for a networked/public
 * deployment), a mandatory CISO sign-off must also be present.
 */
export function assertExecutable(campaign: Campaign, opts: { requireCiso?: boolean } = {}): void {
  if (campaign.status !== 'APPROVED') {
    throw new CampaignError(`Campaign is not executable (status ${campaign.status}).`);
  }
  if (campaign.approvalExpiresAt && Date.parse(campaign.approvalExpiresAt) < Date.now()) {
    throw new CampaignError('Approval has expired (valid for 24h) — please re-submit.');
  }
  if (opts.requireCiso && !campaign.cisoApprovedBy) {
    throw new CampaignError(
      'CISO sign-off required: this deployment mandates a CISO approval on every ' +
        'campaign before it can run.',
    );
  }
}

export function transition(campaign: Campaign, status: CampaignStatus): Campaign {
  return { ...campaign, status };
}
