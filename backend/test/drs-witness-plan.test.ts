import { describe, expect, it } from 'vitest';
import { defaultPlan } from '../src/modules/drs/workflow.js';
import { validatePlan } from '../src/modules/drs/model.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

const campaign = {
  id: 'c1',
  name: 'witness fixture',
  status: 'PENDING_APPROVAL',
  createdBy: 'fixture',
  createdAt: new Date().toISOString(),
  target: 'https://pay.acme.eu/',
  probeUrl: 'https://pay.acme.eu/',
  authorized: true,
  vector: 'http-get',
  maxRps: 100,
  concurrency: 4,
  maxDurationSec: 60,
} as unknown as Campaign;

const withWitness = (witness: { entryUrl?: string; originUrl?: string }) => {
  const plan = defaultPlan(campaign, 'measured');
  plan.witness = witness;
  return () => validatePlan(plan);
};

describe('plan witnesses', () => {
  it('accepts a public https telemetry endpoint', () => {
    expect(withWitness({ entryUrl: 'https://telemetry.client.example/edge' })).not.toThrow();
  });

  it('refuses credentials, a non-http scheme and a private address', () => {
    expect(withWitness({ originUrl: 'https://user:pass@telemetry.example/' })).toThrow(
      /credentials/,
    );
    expect(withWitness({ entryUrl: 'file:///etc/passwd' })).toThrow(/http/);
    expect(withWitness({ entryUrl: 'http://127.0.0.1:9000/counters' })).toThrow(/private address/);
    expect(withWitness({ originUrl: 'http://10.0.0.5/counters' })).toThrow(/private address/);
  });

  it('allows a loopback witness only when the deployment says so', () => {
    process.env.DRS_ALLOW_PRIVATE_WITNESS = '1';
    try {
      expect(withWitness({ entryUrl: 'http://127.0.0.1:9000/counters' })).not.toThrow();
    } finally {
      delete process.env.DRS_ALLOW_PRIVATE_WITNESS;
    }
  });
});
