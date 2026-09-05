import { randomUUID } from 'node:crypto';
import { HARD_CAPS } from './model.js';
import type { Campaign, CampaignInput, CampaignStatus } from './model.js';

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
}

export function createCampaign(
  input: CampaignInput,
  allowedHosts: string[],
  agents?: AgentChoice[],
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

  if (!(input.maxRps > 0) || input.maxRps > HARD_CAPS.maxRps) {
    throw new CampaignError(`maxRps must be within ]0, ${HARD_CAPS.maxRps}].`);
  }
  if (input.concurrency < 1 || input.concurrency > HARD_CAPS.maxConcurrency) {
    throw new CampaignError(`concurrency must be within [1, ${HARD_CAPS.maxConcurrency}].`);
  }
  if (input.maxDurationSec < 1 || input.maxDurationSec > HARD_CAPS.maxDurationSec) {
    throw new CampaignError(`maxDurationSec must be within [1, ${HARD_CAPS.maxDurationSec}].`);
  }

  if (input.scheduledAt !== undefined && Number.isNaN(Date.parse(input.scheduledAt))) {
    throw new CampaignError('scheduledAt: invalid ISO date.');
  }

  if (input.scenario) {
    if (input.scenario.length < 1 || input.scenario.length > 12) {
      throw new CampaignError('A scenario must have between 1 and 12 phases.');
    }
    let totalDur = 0;
    for (const p of input.scenario) {
      if (!(p.maxRps > 0) || p.maxRps > HARD_CAPS.maxRps) {
        throw new CampaignError(`Phase: maxRps must be within ]0, ${HARD_CAPS.maxRps}].`);
      }
      if (p.durationSec < 1) throw new CampaignError('Phase: duration ≥ 1 s.');
      totalDur += p.durationSec;
    }
    if (totalDur > HARD_CAPS.maxDurationSec) {
      throw new CampaignError(`Total scenario duration ≤ ${HARD_CAPS.maxDurationSec}s.`);
    }
    // Normalize the aggregated fields for display/metrics.
    input.maxRps = Math.max(...input.scenario.map((p) => p.maxRps));
    input.maxDurationSec = totalDur;
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

/** Checks a campaign is executable now (approved, not expired). */
export function assertExecutable(campaign: Campaign): void {
  if (campaign.status !== 'APPROVED') {
    throw new CampaignError(`Campaign is not executable (status ${campaign.status}).`);
  }
  if (campaign.approvalExpiresAt && Date.parse(campaign.approvalExpiresAt) < Date.now()) {
    throw new CampaignError('Approval has expired (valid for 24h) — please re-submit.');
  }
}

export function transition(campaign: Campaign, status: CampaignStatus): Campaign {
  return { ...campaign, status };
}
