import { describe, it, expect } from 'vitest';
import {
  createCampaign,
  approveCampaign,
  cisoApproveCampaign,
  assertExecutable,
  cancelCampaign,
  setArchived,
  CampaignError,
} from '../src/modules/campaigns/service.js';
import type { CampaignInput } from '../src/modules/campaigns/model.js';

const allowed = ['localhost'];
const base: CampaignInput = {
  name: 'Resilience test',
  target: 'http://localhost:3000/',
  vector: 'http-get',
  maxRps: 100,
  concurrency: 10,
  maxDurationSec: 60,
  probeUrl: 'http://localhost:3000/health',
  createdBy: 'engineer@wedos',
  authorized: true,
};

describe('CAM workflow', () => {
  it('creates a PENDING_APPROVAL campaign', () => {
    const c = createCampaign(base, allowed);
    expect(c.status).toBe('PENDING_APPROVAL');
  });

  it('rejects a target outside the allowlist', () => {
    expect(() => createCampaign({ ...base, target: 'http://victim.example/' }, allowed)).toThrow(
      CampaignError,
    );
  });

  it('rejects a campaign without an authorization attestation', () => {
    expect(() => createCampaign({ ...base, authorized: false }, allowed)).toThrow(CampaignError);
  });

  it('caps intensity (HARD_CAPS)', () => {
    expect(() => createCampaign({ ...base, maxRps: 999_999 }, allowed)).toThrow(CampaignError);
  });

  it('enforces separation of duties at approval', () => {
    const c = createCampaign(base, allowed);
    expect(() => approveCampaign(c, base.createdBy, 'APPROVED')).toThrow(CampaignError);
  });

  it('approves and makes the campaign executable', () => {
    const c = approveCampaign(createCampaign(base, allowed), 'ciso@wedos', 'APPROVED');
    expect(c.status).toBe('APPROVED');
    expect(() => assertExecutable(c)).not.toThrow();
  });

  it('requires a reason for a rejection', () => {
    const c = createCampaign(base, allowed);
    expect(() => approveCampaign(c, 'ciso@wedos', 'REJECTED')).toThrow(CampaignError);
  });
});

describe('cisoApproveCampaign (dual control)', () => {
  // Approved by one CISO; the dual-control sign-off is a SECOND, different CISO.
  const cisoApproved = () =>
    approveCampaign(createCampaign(base, allowed), 'ciso@wedos', 'APPROVED');

  it('a second CISO co-signs an approved campaign', () => {
    const c = cisoApproveCampaign(cisoApproved(), 'ciso2@wedos');
    expect(c.cisoApprovedBy).toBe('ciso2@wedos');
    expect(c.cisoApprovedAt).toBeTruthy();
  });

  it('refuses to sign a not-yet-approved campaign', () => {
    expect(() => cisoApproveCampaign(createCampaign(base, allowed), 'ciso2@wedos')).toThrow(
      CampaignError,
    );
  });

  it('enforces separation of duties (co-signer ≠ author, co-signer ≠ approver)', () => {
    expect(() => cisoApproveCampaign(cisoApproved(), base.createdBy)).toThrow(/author/);
    expect(() => cisoApproveCampaign(cisoApproved(), 'ciso@wedos')).toThrow(/approver/);
  });

  it('assertExecutable requires the CISO sign-off only when the gate is on', () => {
    const approved = cisoApproved();
    expect(() => assertExecutable(approved)).not.toThrow(); // gate off (default)
    expect(() => assertExecutable(approved, { requireCiso: true })).toThrow(/CISO sign-off/);
    const signed = cisoApproveCampaign(approved, 'ciso2@wedos');
    expect(() => assertExecutable(signed, { requireCiso: true })).not.toThrow();
  });
});

describe('cancelCampaign (annulation)', () => {
  it('cancels a pending campaign to a terminal CANCELLED', () => {
    const c = cancelCampaign(createCampaign(base, allowed));
    expect(c.status).toBe('CANCELLED');
    expect(c.statusDetail).toBeTruthy();
  });

  it('cancels an approved (unrun) campaign, keeping the reason', () => {
    const approved = approveCampaign(createCampaign(base, allowed), 'ciso@wedos', 'APPROVED');
    const c = cancelCampaign(approved, 'no longer needed');
    expect(c.status).toBe('CANCELLED');
    expect(c.statusDetail).toBe('no longer needed');
  });

  it('refuses to cancel a running or already-terminal campaign', () => {
    const running = { ...createCampaign(base, allowed), status: 'RUNNING' as const };
    expect(() => cancelCampaign(running)).toThrow(CampaignError);
    const done = { ...createCampaign(base, allowed), status: 'COMPLETED' as const };
    expect(() => cancelCampaign(done)).toThrow(CampaignError);
  });
});

describe('setArchived', () => {
  it('archives and un-archives a terminal campaign', () => {
    const done = { ...createCampaign(base, allowed), status: 'COMPLETED' as const };
    const archived = setArchived(done, true);
    expect(archived.archived).toBe(true);
    expect(setArchived(archived, false).archived).toBe(false);
  });

  it('is a no-op (same reference) when the flag is unchanged', () => {
    const c = createCampaign(base, allowed);
    expect(setArchived(c, false)).toBe(c); // already un-archived
  });

  it('refuses to archive a running campaign', () => {
    const running = { ...createCampaign(base, allowed), status: 'RUNNING' as const };
    expect(() => setArchived(running, true)).toThrow(CampaignError);
    // …but un-archiving a running campaign is allowed (state-neutral).
    expect(() => setArchived({ ...running, archived: true }, false)).not.toThrow();
  });
});

describe('response assertion validation', () => {
  it('accepts a status assertion on the built-in engine', () => {
    const c = createCampaign({ ...base, assertion: { status: 200 } }, allowed);
    expect(c.assertion?.status).toBe(200);
  });

  it('rejects an empty assertion', () => {
    expect(() => createCampaign({ ...base, assertion: {} }, allowed)).toThrow(CampaignError);
  });

  it('rejects an out-of-range status', () => {
    expect(() => createCampaign({ ...base, assertion: { status: 99 } }, allowed)).toThrow(
      CampaignError,
    );
  });

  it('rejects an assertion on a non-builtin engine', () => {
    expect(() =>
      createCampaign({ ...base, agent: 'k6', assertion: { status: 200 } }, allowed),
    ).toThrow(/built-in engine/);
  });
});

describe('endpoint mix validation', () => {
  it('accepts a valid mix on the built-in engine', () => {
    const c = createCampaign(
      {
        ...base,
        endpoints: [{ url: 'http://localhost/a', weight: 3 }, { url: 'http://localhost/b' }],
      },
      allowed,
    );
    expect(c.endpoints).toHaveLength(2);
  });

  it('rejects an endpoint outside the allowlist', () => {
    expect(() =>
      createCampaign({ ...base, endpoints: [{ url: 'http://victim.example/a' }] }, allowed),
    ).toThrow(CampaignError);
  });

  it('rejects mixing flow and endpoints', () => {
    expect(() =>
      createCampaign(
        {
          ...base,
          flow: [{ method: 'GET', url: 'http://localhost/a' }],
          endpoints: [{ url: 'http://localhost/b' }],
        },
        allowed,
      ),
    ).toThrow(/flow or an endpoint mix/);
  });

  it('accepts a mix on an endpoint-capable engine (k6/vegeta), rejects a non-capable one', () => {
    const AGENTS = [
      {
        id: 'builtin',
        multiPhase: true,
        flowCapable: true,
        endpointCapable: true,
        correlationCapable: true,
      },
      {
        id: 'k6',
        multiPhase: true,
        flowCapable: true,
        endpointCapable: true,
        correlationCapable: false,
      },
      {
        id: 'locust',
        multiPhase: true,
        flowCapable: true,
        endpointCapable: false,
        correlationCapable: false,
      },
    ];
    // k6 honours a recon-seeded endpoint set now.
    expect(
      createCampaign(
        { ...base, agent: 'k6', endpoints: [{ url: 'http://localhost/a' }] },
        allowed,
        AGENTS,
      ).endpoints,
    ).toHaveLength(1);
    // An engine that can't do an endpoint mix is still rejected.
    expect(() =>
      createCampaign(
        { ...base, agent: 'locust', endpoints: [{ url: 'http://localhost/a' }] },
        allowed,
        AGENTS,
      ),
    ).toThrow(/endpoint mix/);
  });
});

describe('user-agent rotation validation', () => {
  it('accepts a UA list on the built-in engine', () => {
    const c = createCampaign({ ...base, userAgents: ['UA/1', 'UA/2'] }, allowed);
    expect(c.userAgents).toHaveLength(2);
  });

  it('rejects an empty UA entry', () => {
    expect(() => createCampaign({ ...base, userAgents: ['UA/1', '  '] }, allowed)).toThrow(
      CampaignError,
    );
  });

  it('accepts UA rotation on vegeta (it spreads the set across its targets file)', () => {
    const c = createCampaign({ ...base, agent: 'vegeta', userAgents: ['UA/1', 'UA/2'] }, allowed);
    expect(c.agent).toBe('vegeta');
    expect(c.userAgents).toHaveLength(2);
  });

  it('rejects UA rotation on k6 (k6 does not rotate UAs yet)', () => {
    expect(() => createCampaign({ ...base, agent: 'k6', userAgents: ['UA/1'] }, allowed)).toThrow(
      /built-in or vegeta engine/,
    );
  });
});

describe('data feeder validation', () => {
  it('accepts a dataset on the built-in engine', () => {
    const c = createCampaign({ ...base, dataset: [{ q: 'a' }, { q: 'b' }] }, allowed);
    expect(c.dataset).toHaveLength(2);
  });

  it('rejects a dataset on a non-builtin engine', () => {
    expect(() => createCampaign({ ...base, agent: 'k6', dataset: [{ q: 'a' }] }, allowed)).toThrow(
      /built-in engine/,
    );
  });
});

describe('recurrence validation', () => {
  it('accepts a valid recurrence', () => {
    const c = createCampaign({ ...base, recurrence: { intervalMin: 60 } }, allowed);
    expect(c.recurrence?.intervalMin).toBe(60);
  });

  it('rejects an interval below the minimum', () => {
    expect(() => createCampaign({ ...base, recurrence: { intervalMin: 5 } }, allowed)).toThrow(
      CampaignError,
    );
  });

  it('rejects a non-integer interval', () => {
    expect(() => createCampaign({ ...base, recurrence: { intervalMin: 22.5 } }, allowed)).toThrow(
      CampaignError,
    );
  });

  it('rejects an "until" in the past', () => {
    expect(() =>
      createCampaign(
        { ...base, recurrence: { intervalMin: 30, until: '2000-01-01T00:00:00Z' } },
        allowed,
      ),
    ).toThrow(CampaignError);
  });
});
