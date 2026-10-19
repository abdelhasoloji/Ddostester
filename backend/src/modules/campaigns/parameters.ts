import { createHash } from 'node:crypto';
import type { Campaign } from './model.js';
import type { HardCaps } from '../../config/limits.js';
import { CampaignError } from './service.js';

export function parameterRevision(c: Campaign): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}
export function editableParameters(c: Campaign): void {
  if (!['PENDING_APPROVAL', 'APPROVED'].includes(c.status) || c.runId || c.archived)
    throw new CampaignError('Only an unstarted, unarchived campaign can be edited.');
  if (c.drsDocument || c.fleetDeviceIds?.length || c.agent === 'fleet')
    throw new CampaignError(
      'Frozen DRS and Fleet plans must be revised through their own workflow.',
    );
}
export function parameterInput(c: Campaign, body: Record<string, unknown>, caps: HardCaps) {
  editableParameters(c);
  const allowed = new Set(['revision', 'maxRps', 'concurrency', 'maxDurationSec', 'scenario']);
  if (Object.keys(body).some((k) => !allowed.has(k))) throw new CampaignError('Unknown parameter.');
  for (const [key, ceiling] of Object.entries(caps)) {
    const field = key === 'maxConcurrency' ? 'concurrency' : key;
    const value = body[field];
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > ceiling)
      throw new CampaignError(`${field} must be an integer within [1, ${ceiling}].`);
  }
  const next = {
    ...c,
    maxRps: body.maxRps as number,
    concurrency: body.concurrency as number,
    maxDurationSec: body.maxDurationSec as number,
  };
  if (c.scenario) {
    if (!Array.isArray(body.scenario) || body.scenario.length !== c.scenario.length)
      throw new CampaignError('Preserve the existing scenario phases.');
    next.scenario = c.scenario.map((phase, index) => {
      const p = (body.scenario as Record<string, unknown>[])[index];
      if (!p || Object.keys(p).some((k) => !['maxRps', 'durationSec'].includes(k)))
        throw new CampaignError('Only phase rate and duration are editable.');
      return { ...phase, maxRps: p.maxRps as number, durationSec: p.durationSec as number };
    });
    if (
      Math.max(...next.scenario.map((p) => p.maxRps)) !== next.maxRps ||
      next.scenario.reduce((sum, p) => sum + p.durationSec, 0) !== next.maxDurationSec
    )
      throw new CampaignError('Scenario totals must match the campaign rate and duration.');
  } else if (body.scenario !== undefined) throw new CampaignError('Cannot add scenario phases.');
  return next;
}
