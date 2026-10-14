import { describe, expect, it } from 'vitest';
import { validateKusaProposal } from '../src/modules/assistant/proposals.js';
const policy = {
  allowedHosts: ['target.test'],
  caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
  userMode: 'single' as const,
};
const proposal = {
  schema: 'ddostester.kusa.proposal/v1',
  type: 'test-campaign',
  name: 'bounded proposal',
  target: 'http://target.test/',
  vector: 'http-get',
  maxRps: 5,
  concurrency: 2,
  maxDurationSec: 10,
};
describe('Kusa proposals have no executable authority', () => {
  it('returns a reviewable proposal, without issuing approval', () => {
    expect(validateKusaProposal(proposal, policy)).toMatchObject({
      requiresOperatorReview: true,
      launchPolicy: 'owner-confirmation',
    });
  });
  it.each([
    { command: 'shell' },
    { approved: true },
    { createdBy: 'admin' },
    { target: 'http://outside.test/' },
    { target: 'file:///etc/passwd' },
    { maxRps: 16 },
    { schema: 'future' },
    { type: 'pod-start' },
  ])('rejects injected authority or scope %j', (over) => {
    expect(() => validateKusaProposal({ ...proposal, ...over }, policy)).toThrow();
  });
  it('preserves team separation even when the model asks to launch', () => {
    expect(validateKusaProposal(proposal, { ...policy, userMode: 'team' }).launchPolicy).toBe(
      'separation-of-duties',
    );
  });
  it('allows tightening only, never a model-proposed cap increase', () => {
    expect(() =>
      validateKusaProposal(
        {
          schema: proposal.schema,
          type: 'adjust-limits',
          maxRps: 20,
          maxConcurrency: 6,
          maxDurationSec: 60,
        },
        policy,
      ),
    ).toThrow();
  });
});
