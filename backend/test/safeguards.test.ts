import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createCampaign,
  approveCampaign,
  CampaignError,
} from '../src/modules/campaigns/service.js';
import { HARD_CAPS } from '../src/modules/campaigns/model.js';
import type { CampaignInput } from '../src/modules/campaigns/model.js';
import {
  validateConfig,
  InvalidConfigError,
  TargetNotAllowedError,
} from '../src/engine/loadTest.js';
import type { LoadTestConfig } from '../src/engine/types.js';

/**
 * The safeguards suite: the tool's security boundary made executable. No input —
 * however malformed or adversarial — may exceed the caps, escape the allowlist,
 * bypass the authorization attestation, or defeat separation of duties.
 */

const allowed = ['localhost'];
const base: CampaignInput = {
  name: 'x',
  target: 'http://localhost/',
  vector: 'http-get',
  maxRps: 10,
  concurrency: 2,
  maxDurationSec: 10,
  probeUrl: 'http://localhost/',
  createdBy: 'eng@wedos',
  authorized: true,
};

describe('safeguards — campaign creation', () => {
  it('rejects ANY target host outside the allowlist', () => {
    fc.assert(
      fc.property(
        fc.domain().filter((d) => !allowed.includes(d)),
        (host) => {
          expect(() => createCampaign({ ...base, target: `http://${host}/` }, allowed)).toThrow(
            CampaignError,
          );
        },
      ),
    );
  });

  it('rejects ANY probe host outside the allowlist', () => {
    fc.assert(
      fc.property(
        fc.domain().filter((d) => !allowed.includes(d)),
        (host) => {
          expect(() => createCampaign({ ...base, probeUrl: `http://${host}/` }, allowed)).toThrow(
            CampaignError,
          );
        },
      ),
    );
  });

  it('never accepts a rate above the hard cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: HARD_CAPS.maxRps + 1, max: 10_000_000 }), (rps) => {
        expect(() => createCampaign({ ...base, maxRps: rps }, allowed)).toThrow(CampaignError);
      }),
    );
  });

  it('never accepts concurrency or duration above the hard caps', () => {
    fc.assert(
      fc.property(fc.integer({ min: HARD_CAPS.maxConcurrency + 1, max: 1_000_000 }), (n) => {
        expect(() => createCampaign({ ...base, concurrency: n }, allowed)).toThrow(CampaignError);
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: HARD_CAPS.maxDurationSec + 1, max: 10_000_000 }), (d) => {
        expect(() => createCampaign({ ...base, maxDurationSec: d }, allowed)).toThrow(
          CampaignError,
        );
      }),
    );
  });

  it('never accepts a scenario phase above the rate cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: HARD_CAPS.maxRps + 1, max: 10_000_000 }), (rps) => {
        expect(() =>
          createCampaign({ ...base, scenario: [{ maxRps: rps, durationSec: 10 }] }, allowed),
        ).toThrow(CampaignError);
      }),
    );
  });

  it('always requires the authorization attestation', () => {
    expect(() => createCampaign({ ...base, authorized: false }, allowed)).toThrow(CampaignError);
  });

  it('rejects a flow / endpoint / non-http target off the allowlist', () => {
    expect(() =>
      createCampaign({ ...base, flow: [{ method: 'GET', url: 'http://evil.example/a' }] }, allowed),
    ).toThrow(CampaignError);
    expect(() =>
      createCampaign({ ...base, endpoints: [{ url: 'http://evil.example/a' }] }, allowed),
    ).toThrow(CampaignError);
    expect(() => createCampaign({ ...base, target: 'ftp://localhost/' }, allowed)).toThrow(
      CampaignError,
    );
  });
});

describe('safeguards — separation of duties', () => {
  it('an author can never approve their own campaign', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        const c = createCampaign({ ...base, createdBy: email }, allowed);
        expect(() => approveCampaign(c, email, 'APPROVED')).toThrow(CampaignError);
      }),
    );
  });
});

describe('safeguards — engine validateConfig', () => {
  const cfg = (over: Partial<LoadTestConfig>): LoadTestConfig => ({
    url: 'http://localhost/',
    concurrency: 5,
    durationSec: 3,
    maxRps: 50,
    authorized: true,
    ...over,
  });

  it('refuses an unauthorized run', () => {
    expect(() => validateConfig(cfg({ authorized: false }), allowed)).toThrow(InvalidConfigError);
  });

  it('refuses ANY target off the allowlist', () => {
    fc.assert(
      fc.property(
        fc.domain().filter((d) => !allowed.includes(d)),
        (host) => {
          expect(() => validateConfig(cfg({ url: `http://${host}/` }), allowed)).toThrow(
            TargetNotAllowedError,
          );
        },
      ),
    );
  });

  it('bounds concurrency and rate at the engine level too', () => {
    expect(() => validateConfig(cfg({ concurrency: 5000 }), allowed)).toThrow(InvalidConfigError);
    expect(() => validateConfig(cfg({ maxRps: 0 }), allowed)).toThrow(InvalidConfigError);
  });
});
