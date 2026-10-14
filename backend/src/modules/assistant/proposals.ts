import { assertDestination } from '../../util/destination.js';
import { withinCeiling, type HardCaps } from '../../config/limits.js';
const SCHEMA = 'ddostester.kusa.proposal/v1';
const screens = ['overview', 'zones', 'campaigns', 'theater', 'settings'];
export interface ProposalPolicy {
  allowedHosts: string[];
  caps: HardCaps;
  userMode: 'single' | 'team';
}
/** A proposal is validated data, never an approval or execution capability. */
export function validateKusaProposal(
  value: unknown,
  policy: ProposalPolicy,
): {
  schema: string;
  type: string;
  proposal: Record<string, unknown>;
  requiresOperatorReview: true;
  launchPolicy: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !withinCeiling(policy.caps))
    throw new Error('Invalid proposal or policy');
  const x = value as Record<string, unknown>;
  if (x.schema !== SCHEMA) throw new Error('Unsupported proposal schema');
  const allowed: Record<string, string[]> = {
    'test-campaign': [
      'schema',
      'type',
      'name',
      'target',
      'vector',
      'maxRps',
      'concurrency',
      'maxDurationSec',
      'rationale',
    ],
    'adjust-limits': ['schema', 'type', 'maxRps', 'maxConcurrency', 'maxDurationSec', 'rationale'],
    open: ['schema', 'type', 'screen', 'label', 'rationale'],
  };
  if (
    typeof x.type !== 'string' ||
    !Object.hasOwn(allowed, x.type) ||
    Object.keys(x).some((key) => !allowed[x.type as string].includes(key))
  )
    throw new Error('Unsupported proposal fields or action');
  for (const field of ['name', 'rationale', 'label'])
    if (
      x[field] !== undefined &&
      (typeof x[field] !== 'string' || (x[field] as string).length > 400)
    )
      throw new Error('Invalid proposal text');
  const bound = (field: string, cap: number) => {
    const n = x[field];
    if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > cap)
      throw new Error('Proposal exceeds current operational limits');
  };
  if (x.type === 'test-campaign') {
    if (typeof x.target !== 'string' || x.vector !== 'http-get')
      throw new Error('Kusa lab proposal requires a bounded HTTP GET');
    assertDestination(x.target, policy.allowedHosts);
    bound('maxRps', policy.caps.maxRps);
    bound('concurrency', policy.caps.maxConcurrency);
    bound('maxDurationSec', policy.caps.maxDurationSec);
  } else if (x.type === 'adjust-limits') {
    bound('maxRps', policy.caps.maxRps);
    bound('maxConcurrency', policy.caps.maxConcurrency);
    bound('maxDurationSec', policy.caps.maxDurationSec);
  } else if (typeof x.screen !== 'string' || !screens.includes(x.screen))
    throw new Error('Unknown governed screen');
  return {
    schema: SCHEMA,
    type: x.type,
    proposal: { ...x },
    requiresOperatorReview: true,
    launchPolicy: policy.userMode === 'single' ? 'owner-confirmation' : 'separation-of-duties',
  };
}
