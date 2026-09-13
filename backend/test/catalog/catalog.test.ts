import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  buildAuthedApp,
  buildOpenApp,
  bearer,
  campaign,
  CREDS,
  ROLE_KEYS,
  type RoleKey,
  record,
  results,
  type Outcome,
} from './harness.js';
import { can } from '../../src/auth/rbac.js';
import type { Permission } from '../../src/auth/rbac.js';

// Data-driven functional catalog: hundreds of cases crossing roles × routes ×
// inputs × states, each with an expected result argued against a rule in
// docs/test-catalog/specification.md. Cases whose observed behaviour diverges
// from the spec principle are tagged FINDING (the assertion pins current
// behaviour so the suite stays green while the report flags the gap).

let authed: Awaited<ReturnType<typeof buildAuthedApp>>;
let open: FastifyInstance;

// End-to-end cases actually execute campaigns; each real run has a ~5 s floor
// (the legitimate probe's poll interval). They are gated behind CATALOG_E2E=1 so
// the everyday `npm test` stays fast; CI runs the full set with the flag on.
const E2E = process.env.CATALOG_E2E === '1';
const itE2E = E2E ? it : it.skip;

beforeAll(async () => {
  authed = await buildAuthedApp();
  open = await buildOpenApp();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
interface RouteDef {
  m: Method;
  u: string;
  perm: Permission;
  body?: () => Record<string, unknown>;
}

// Every guarded /api route with its required permission (SPEC-RBAC-2).
const ROUTES: RouteDef[] = [
  { m: 'GET', u: '/api/campaigns', perm: 'campaign:read' },
  { m: 'GET', u: '/api/campaigns/nope', perm: 'campaign:read' },
  { m: 'GET', u: '/api/auth/me', perm: 'campaign:read' },
  { m: 'GET', u: '/api/playbooks', perm: 'campaign:read' },
  { m: 'GET', u: '/api/suites', perm: 'campaign:read' },
  { m: 'GET', u: '/api/suites/nope', perm: 'campaign:read' },
  { m: 'GET', u: '/api/wrs/history', perm: 'campaign:read' },
  { m: 'GET', u: '/api/audit', perm: 'campaign:read' },
  { m: 'GET', u: '/api/audit/verify', perm: 'campaign:read' },
  { m: 'GET', u: '/api/audit/export', perm: 'campaign:read' },
  { m: 'GET', u: '/api/runs', perm: 'campaign:read' },
  { m: 'GET', u: '/api/runs/nope', perm: 'campaign:read' },
  { m: 'POST', u: '/api/notify/test', perm: 'campaign:create', body: () => ({}) },
  { m: 'POST', u: '/api/campaigns', perm: 'campaign:create', body: () => campaign() },
  {
    m: 'POST',
    u: '/api/playbooks',
    perm: 'campaign:create',
    body: () => ({ name: `pb-${Math.random().toString(36).slice(2)}`, steps: [] }),
  },
  { m: 'DELETE', u: '/api/playbooks/nope', perm: 'campaign:create' },
  { m: 'POST', u: '/api/playbooks/nope/instantiate', perm: 'campaign:create', body: () => ({}) },
  {
    m: 'POST',
    u: '/api/campaigns/nope/approval',
    perm: 'campaign:approve',
    body: () => ({ decision: 'APPROVED', approvedBy: 'off@wedos' }),
  },
  { m: 'POST', u: '/api/campaigns/nope/execute', perm: 'campaign:execute' },
  { m: 'POST', u: '/api/campaigns/nope/kill', perm: 'campaign:kill' },
  { m: 'GET', u: '/api/users', perm: 'user:manage' },
  {
    m: 'POST',
    u: '/api/users',
    perm: 'user:manage',
    body: () => ({
      email: `u-${Math.random().toString(36).slice(2)}@wedos`,
      role: 'viewer',
      password: 'a-strong-password',
    }),
  },
  { m: 'PATCH', u: '/api/users/nope@wedos', perm: 'user:manage', body: () => ({ role: 'viewer' }) },
  { m: 'DELETE', u: '/api/users/nope@wedos', perm: 'user:manage' },
];

let seq = 0;
function reg(
  area: string,
  title: string,
  spec: string,
  want: string,
  got: string,
  pass: boolean,
  outcome: Outcome = 'CONFORMS',
  note?: string,
): boolean {
  seq += 1;
  const id = `${area}-${String(seq).padStart(3, '0')}`;
  record({ id, area, title, spec, want, got, pass, outcome, note });
  return pass;
}

async function hit(
  app: FastifyInstance,
  m: Method,
  u: string,
  opts: { token?: string; body?: Record<string, unknown> } = {},
) {
  return app.inject({
    method: m,
    url: u,
    headers: opts.token ? bearer(opts.token) : undefined,
    payload: opts.body,
  });
}

// ---------------------------------------------------------------------------
// A. RBAC route matrix — permission, no-token, and auth-disabled variants.
// ---------------------------------------------------------------------------
describe('A. RBAC route matrix', () => {
  it('permission matrix: role with perm reaches handler, role without gets 403', async () => {
    for (const rt of ROUTES) {
      for (const role of ROLE_KEYS) {
        const res = await hit(authed.app, rt.m, rt.u, {
          token: authed.tokens[role],
          body: rt.body?.(),
        });
        const allowed = can(CREDS[role].role, rt.perm);
        const want = allowed ? 'not 401/403' : '403';
        const got = String(res.statusCode);
        const pass = allowed
          ? res.statusCode !== 401 && res.statusCode !== 403
          : res.statusCode === 403;
        reg('RBAC', `${role} ${rt.m} ${rt.u} (${rt.perm})`, 'SPEC-RBAC-1/2', want, got, pass);
        expect(pass, `${role} ${rt.m} ${rt.u} → ${got}`).toBe(true);
      }
    }
  });

  it('no token → 401 on every guarded route', async () => {
    for (const rt of ROUTES) {
      const res = await hit(authed.app, rt.m, rt.u, { body: rt.body?.() });
      const pass = res.statusCode === 401;
      reg('RBAC', `no-token ${rt.m} ${rt.u}`, 'SPEC-RBAC-2', '401', String(res.statusCode), pass);
      expect(pass, `no-token ${rt.m} ${rt.u} → ${res.statusCode}`).toBe(true);
    }
  });

  it('auth disabled → every route open (no 401/403)', async () => {
    for (const rt of ROUTES) {
      const res = await hit(open, rt.m, rt.u, { body: rt.body?.() });
      const pass = res.statusCode !== 401 && res.statusCode !== 403;
      reg(
        'RBAC',
        `auth-off ${rt.m} ${rt.u}`,
        'SPEC-RBAC-3',
        'not 401/403',
        String(res.statusCode),
        pass,
      );
      expect(pass, `auth-off ${rt.m} ${rt.u} → ${res.statusCode}`).toBe(true);
    }
  });

  it('kill switch is available to every operating role, not the viewer (SPEC-RBAC-4)', async () => {
    for (const role of ROLE_KEYS) {
      const res = await hit(authed.app, 'POST', '/api/campaigns/nope/kill', {
        token: authed.tokens[role],
      });
      // Engineer/CISO/admin reach the handler (404, no active run); the read-only
      // viewer is forbidden (403).
      const expectAllowed = role !== 'viewer';
      const pass = (res.statusCode !== 403) === expectAllowed;
      reg(
        'RBAC',
        `${role} kill switch ${expectAllowed ? 'allowed' : 'forbidden'}`,
        'SPEC-RBAC-4',
        expectAllowed ? 'not 403' : '403',
        String(res.statusCode),
        pass,
      );
      expect(pass).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Allowlist matrix (SPEC-ALLOW-1..3). Engineer has create.
// ---------------------------------------------------------------------------
describe('B. Allowlist matrix', () => {
  interface Val {
    value: string;
    want: 201 | 400;
    spec: string;
  }
  // The same rule governs target and probe (assertHostAllowed), so the whole
  // value table is applied to both fields.
  const VALUES: Val[] = [
    { value: 'http://127.0.0.1/', want: 201, spec: 'SPEC-ALLOW-1' },
    { value: 'http://localhost/', want: 201, spec: 'SPEC-ALLOW-1' },
    { value: 'https://127.0.0.1/', want: 201, spec: 'SPEC-ALLOW-2' },
    { value: 'https://localhost/', want: 201, spec: 'SPEC-ALLOW-2' },
    {
      value: 'http://127.0.0.1:8080/deep/path?q=1',
      want: 201,
      spec: 'SPEC-ALLOW-1 (port/path/query)',
    },
    { value: 'http://LOCALHOST/', want: 201, spec: 'SPEC-ALLOW-3 (URL lowercases host)' },
    {
      value: 'http://user@127.0.0.1/',
      want: 201,
      spec: 'SPEC-ALLOW-1 (userinfo, host still 127.0.0.1)',
    },
    { value: 'http://evil.example.com/', want: 400, spec: 'SPEC-ALLOW-1' },
    { value: 'http://127.0.0.1.evil.com/', want: 400, spec: 'SPEC-ALLOW-3 (suffix trick)' },
    { value: 'http://evil.com/?x=127.0.0.1', want: 400, spec: 'SPEC-ALLOW-3 (host in query)' },
    { value: 'http://sub.localhost/', want: 400, spec: 'SPEC-ALLOW-3 (subdomain)' },
    { value: 'http://10.0.0.1/', want: 400, spec: 'SPEC-ALLOW-1 (private but not allowlisted)' },
    { value: 'http://169.254.169.254/', want: 400, spec: 'SPEC-ALLOW-1 (cloud metadata)' },
    { value: 'http://0.0.0.0/', want: 400, spec: 'SPEC-ALLOW-1' },
    { value: 'http://[::1]/', want: 400, spec: 'SPEC-ALLOW-3 (IPv6 loopback not allowlisted)' },
    { value: 'ftp://127.0.0.1/', want: 400, spec: 'SPEC-ALLOW-2' },
    { value: 'file:///etc/passwd', want: 400, spec: 'SPEC-ALLOW-2' },
    { value: 'gopher://127.0.0.1/', want: 400, spec: 'SPEC-ALLOW-2' },
    { value: 'javascript:alert(1)', want: 400, spec: 'SPEC-ALLOW-2' },
    { value: 'not-a-url', want: 400, spec: 'SPEC-ALLOW-1 (invalid URL)' },
    { value: '', want: 400, spec: 'SPEC-ALLOW-1 (empty)' },
  ];

  // Every host-bearing field goes through the same guard, so the value table is
  // applied to all four: target, probe, flow-step URL, and weighted endpoint URL.
  const builders: Record<string, (v: string) => Record<string, unknown>> = {
    target: (v) => ({ target: v }),
    probeUrl: (v) => ({ probeUrl: v }),
    'flow.step.url': (v) => ({ flow: [{ method: 'GET', url: v }] }),
    'endpoint.url': (v) => ({ endpoints: [{ url: v, weight: 1 }] }),
  };

  it('allowlist + scheme rule holds for target, probe, flow steps and endpoints', async () => {
    for (const [field, build] of Object.entries(builders)) {
      for (const c of VALUES) {
        const res = await hit(authed.app, 'POST', '/api/campaigns', {
          token: authed.tokens.engineer,
          body: campaign(build(c.value)),
        });
        const pass = res.statusCode === c.want;
        reg(
          'ALLOW',
          `${field}=${JSON.stringify(c.value)}`,
          c.spec,
          String(c.want),
          String(res.statusCode),
          pass,
        );
        expect(pass, `${field}=${c.value} → ${res.statusCode} (want ${c.want})`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// C. Hard-caps matrix (SPEC-CAP-1).
// ---------------------------------------------------------------------------
describe('C. Hard-caps matrix', () => {
  interface CapCase {
    field: 'maxRps' | 'concurrency' | 'maxDurationSec';
    value: unknown;
    want: 201 | 400;
    outcome?: Outcome;
    note?: string;
  }
  const cases: CapCase[] = [
    // maxRps: valid iff >0 && <=2000
    { field: 'maxRps', value: -1, want: 400 },
    { field: 'maxRps', value: 0, want: 400 },
    { field: 'maxRps', value: 1, want: 201 },
    { field: 'maxRps', value: 2000, want: 201 },
    { field: 'maxRps', value: 2001, want: 400 },
    { field: 'maxRps', value: 1_000_000, want: 400 },
    { field: 'maxRps', value: 'abc', want: 400, note: 'non-numeric coerces to NaN → rejected' },
    {
      field: 'maxRps',
      value: 0.5,
      want: 400,
      note: 'fractional rps rejected (caps must be whole numbers)',
    },
    // concurrency: valid iff >=1 && <=500
    { field: 'concurrency', value: 0, want: 400 },
    { field: 'concurrency', value: 1, want: 201 },
    { field: 'concurrency', value: 500, want: 201 },
    { field: 'concurrency', value: 501, want: 400 },
    { field: 'concurrency', value: 99999, want: 400 },
    {
      field: 'concurrency',
      value: 1.5,
      want: 400,
      note: 'fractional concurrency rejected (integer required)',
    },
    // maxDurationSec: valid iff >=1 && <=900
    { field: 'maxDurationSec', value: 0, want: 400 },
    { field: 'maxDurationSec', value: 1, want: 201 },
    { field: 'maxDurationSec', value: 900, want: 201 },
    { field: 'maxDurationSec', value: 901, want: 400 },
    { field: 'maxDurationSec', value: 100000, want: 400 },
  ];

  it('each cap rejects ≤0 / non-finite / above-cap and accepts the boundary', async () => {
    for (const c of cases) {
      const res = await hit(authed.app, 'POST', '/api/campaigns', {
        token: authed.tokens.engineer,
        body: campaign({ [c.field]: c.value }),
      });
      const pass = res.statusCode === c.want;
      reg(
        'CAP',
        `${c.field}=${JSON.stringify(c.value)}`,
        'SPEC-CAP-1',
        String(c.want),
        String(res.statusCode),
        pass,
        c.outcome ?? 'CONFORMS',
        c.note,
      );
      expect(pass, `${c.field}=${c.value} → ${res.statusCode} (want ${c.want})`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// D. Attestation & required fields (SPEC-ATT-1).
// ---------------------------------------------------------------------------
describe('D. Attestation & required fields', () => {
  interface FieldCase {
    title: string;
    body: Record<string, unknown>;
    want: 201 | 400;
    spec: string;
  }
  const cases: FieldCase[] = [
    {
      title: 'authorized:true',
      body: campaign({ authorized: true }),
      want: 201,
      spec: 'SPEC-ATT-1',
    },
    {
      title: 'authorized:false',
      body: campaign({ authorized: false }),
      want: 400,
      spec: 'SPEC-ATT-1',
    },
    {
      title: 'authorized missing',
      body: campaign({ authorized: undefined }),
      want: 400,
      spec: 'SPEC-ATT-1',
    },
    { title: 'name empty', body: campaign({ name: '' }), want: 400, spec: 'required fields' },
    {
      title: 'name missing',
      body: campaign({ name: undefined }),
      want: 400,
      spec: 'required fields',
    },
  ];
  it('attestation and required fields are enforced', async () => {
    for (const c of cases) {
      const res = await hit(authed.app, 'POST', '/api/campaigns', {
        token: authed.tokens.engineer,
        body: c.body,
      });
      const pass = res.statusCode === c.want;
      reg('ATTEST', c.title, c.spec, String(c.want), String(res.statusCode), pass);
      expect(pass, `${c.title} → ${res.statusCode}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// E. Approval / separation of duties (SPEC-SOD-1/2, SPEC-LIFE-*).
// ---------------------------------------------------------------------------
describe('E. Approval & separation of duties', () => {
  async function createAs(role: RoleKey, over: Record<string, unknown> = {}) {
    const res = await hit(authed.app, 'POST', '/api/campaigns', {
      token: authed.tokens[role],
      body: campaign({ createdBy: CREDS[role].email, ...over }),
    });
    return res.json() as { id: string };
  }
  async function approve(role: RoleKey, id: string, approvedBy: string, decision = 'APPROVED') {
    return hit(authed.app, 'POST', `/api/campaigns/${id}/approval`, {
      token: authed.tokens[role],
      body: { decision, approvedBy, reason: decision === 'REJECTED' ? 'because' : undefined },
    });
  }

  it('ciso approves a campaign authored by the engineer (SoD satisfied)', async () => {
    const c = await createAs('engineer');
    const res = await approve('ciso', c.id, CREDS.ciso.email);
    const pass = res.statusCode === 200;
    reg(
      'SOD',
      'ciso approves engineer’s campaign',
      'SPEC-SOD-1',
      '200',
      String(res.statusCode),
      pass,
    );
    expect(pass).toBe(true);
  });

  it('ciso cannot author a campaign, so self-approval cannot arise', async () => {
    // The approver (CISO) has no create permission — author ≠ approver is
    // structural, not just a runtime check.
    const res = await hit(authed.app, 'POST', '/api/campaigns', {
      token: authed.tokens.ciso,
      body: campaign({ createdBy: CREDS.ciso.email }),
    });
    const pass = res.statusCode === 403;
    reg(
      'SOD',
      'ciso cannot author (self-approval impossible)',
      'SPEC-SOD-1',
      '403',
      String(res.statusCode),
      pass,
    );
    expect(pass).toBe(true);
  });

  it('engineer cannot approve at all (no permission)', async () => {
    const c = await createAs('engineer');
    const res = await approve('engineer', c.id, CREDS.engineer.email);
    const pass = res.statusCode === 403;
    reg('SOD', 'engineer approve denied', 'SPEC-RBAC-1', '403', String(res.statusCode), pass);
    expect(pass).toBe(true);
  });

  it('approving a non-existent campaign is 404', async () => {
    const res = await approve('ciso', 'does-not-exist', CREDS.ciso.email);
    const pass = res.statusCode === 404;
    reg('SOD', 'approve unknown id', 'SPEC-LIFE-3', '404', String(res.statusCode), pass);
    expect(pass).toBe(true);
  });

  it('the approver of a campaign cannot also execute it (SoD extended)', async () => {
    // Officer approves a campaign they did not author, then tries to run it.
    const c = await createAs('engineer', { maxDurationSec: 1 });
    await approve('ciso', c.id, CREDS.ciso.email);
    const run = await hit(authed.app, 'POST', `/api/campaigns/${c.id}/execute`, {
      token: authed.tokens.ciso,
    });
    const blocked = run.statusCode === 403;
    reg(
      'SOD',
      'approver cannot also execute',
      'SPEC-SOD-2',
      '403',
      String(run.statusCode),
      blocked,
    );
    expect(blocked, `ciso approve+execute → ${run.statusCode}`).toBe(true);
  });

  itE2E(
    'a different actor (the engineer author) may execute an ciso-approved campaign',
    async () => {
      const c = await createAs('engineer', { maxDurationSec: 1 });
      await approve('ciso', c.id, CREDS.ciso.email);
      const run = await hit(authed.app, 'POST', `/api/campaigns/${c.id}/execute`, {
        token: authed.tokens.engineer,
      });
      const executed = run.statusCode === 201;
      reg(
        'SOD',
        'executor ≠ approver is allowed',
        'SPEC-SOD-2',
        '201',
        String(run.statusCode),
        executed,
      );
      expect(executed, `engineer execute → ${run.statusCode}`).toBe(true);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// F. Lifecycle / execution guard (SPEC-LIFE-2/3).
// ---------------------------------------------------------------------------
describe('F. Lifecycle & execution', () => {
  it('a PENDING campaign cannot be executed', async () => {
    const c = (
      await hit(authed.app, 'POST', '/api/campaigns', {
        token: authed.tokens.engineer,
        body: campaign(),
      })
    ).json() as { id: string };
    const res = await hit(authed.app, 'POST', `/api/campaigns/${c.id}/execute`, {
      token: authed.tokens.engineer,
    });
    const pass = res.statusCode >= 400 && res.statusCode < 500; // rejected, not run
    reg(
      'LIFE',
      'execute a non-approved campaign',
      'SPEC-LIFE-2',
      '4xx',
      String(res.statusCode),
      pass,
    );
    expect(pass, `execute pending → ${res.statusCode}`).toBe(true);
  });

  it('executing / killing unknown ids is 404', async () => {
    const ex = await hit(authed.app, 'POST', '/api/campaigns/none/execute', {
      token: authed.tokens.engineer,
    });
    reg(
      'LIFE',
      'execute unknown id',
      'SPEC-LIFE-3',
      '404',
      String(ex.statusCode),
      ex.statusCode === 404,
    );
    expect(ex.statusCode).toBe(404);
    const k = await hit(authed.app, 'POST', '/api/campaigns/none/kill', {
      token: authed.tokens.engineer,
    });
    reg(
      'LIFE',
      'kill unknown id',
      'SPEC-LIFE-3',
      '404',
      String(k.statusCode),
      k.statusCode === 404,
    );
    expect(k.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// G. Users governance (SPEC-USER-1/2/3).
// ---------------------------------------------------------------------------
describe('G. Users governance', () => {
  it('only the admin manages users; validation & immutability hold', async () => {
    // Non-cisos are denied (already in the matrix, re-asserted for the area).
    for (const role of ['engineer', 'ciso', 'viewer'] as RoleKey[]) {
      const r = await hit(authed.app, 'GET', '/api/users', { token: authed.tokens[role] });
      reg(
        'USER',
        `${role} cannot list users`,
        'SPEC-USER-1',
        '403',
        String(r.statusCode),
        r.statusCode === 403,
      );
      expect(r.statusCode).toBe(403);
    }

    // Create a valid user.
    const email = `new-${Math.random().toString(36).slice(2)}@wedos`;
    const create = await hit(authed.app, 'POST', '/api/users', {
      token: authed.tokens.admin,
      body: { email, role: 'engineer', password: 'a-strong-password' },
    });
    reg(
      'USER',
      'ciso creates a valid user',
      'SPEC-USER-1',
      '2xx',
      String(create.statusCode),
      create.statusCode < 300,
    );
    expect(create.statusCode).toBeLessThan(300);

    // Re-creating an existing store user is a 409 (create-only, no silent overwrite).
    const dup = await hit(authed.app, 'POST', '/api/users', {
      token: authed.tokens.admin,
      body: { email, role: 'viewer', password: 'a-different-password' },
    });
    const is409 = dup.statusCode === 409;
    reg(
      'USER',
      're-creating an existing user is rejected (409)',
      'SPEC-USER-1',
      '409',
      String(dup.statusCode),
      is409,
    );
    expect(is409, `re-create → ${dup.statusCode}`).toBe(true);

    // Weak password rejected.
    const weak = await hit(authed.app, 'POST', '/api/users', {
      token: authed.tokens.admin,
      body: {
        email: `weak-${Math.random().toString(36).slice(2)}@wedos`,
        role: 'viewer',
        password: 'x',
      },
    });
    reg(
      'USER',
      'weak password rejected',
      'SPEC-USER-3',
      '4xx',
      String(weak.statusCode),
      weak.statusCode >= 400 && weak.statusCode < 500,
    );
    expect(weak.statusCode).toBeGreaterThanOrEqual(400);

    // Invalid role rejected.
    const badRole = await hit(authed.app, 'POST', '/api/users', {
      token: authed.tokens.admin,
      body: {
        email: `role-${Math.random().toString(36).slice(2)}@wedos`,
        role: 'superadmin',
        password: 'a-strong-password',
      },
    });
    reg(
      'USER',
      'invalid role rejected',
      'SPEC-USER-1',
      '4xx',
      String(badRole.statusCode),
      badRole.statusCode >= 400 && badRole.statusCode < 500,
    );
    expect(badRole.statusCode).toBeGreaterThanOrEqual(400);

    // Env-defined root user cannot be deleted.
    const delEnv = await hit(
      authed.app,
      'DELETE',
      `/api/users/${encodeURIComponent(CREDS.ciso.email)}`,
      {
        token: authed.tokens.admin,
      },
    );
    reg(
      'USER',
      'env-defined root user is immutable',
      'SPEC-USER-2',
      '4xx',
      String(delEnv.statusCode),
      delEnv.statusCode >= 400 && delEnv.statusCode < 500,
    );
    expect(delEnv.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// H. Audit trail (SPEC-AUDIT-1).
// ---------------------------------------------------------------------------
describe('H. Audit trail', () => {
  it('privileged actions are audited and the chain verifies intact', async () => {
    // Generate some auditable activity.
    await hit(authed.app, 'POST', '/api/campaigns', {
      token: authed.tokens.engineer,
      body: campaign(),
    });
    const list = await hit(authed.app, 'GET', '/api/audit', { token: authed.tokens.ciso });
    const entries = list.json() as unknown[];
    const nonEmpty = Array.isArray(entries) && entries.length > 0;
    reg(
      'AUDIT',
      'audit trail is non-empty after activity',
      'SPEC-AUDIT-1',
      'entries > 0',
      String((entries as unknown[]).length),
      nonEmpty,
    );
    expect(nonEmpty).toBe(true);

    const verify = await hit(authed.app, 'GET', '/api/audit/verify', {
      token: authed.tokens.ciso,
    });
    const v = verify.json() as { ok?: boolean; valid?: boolean };
    const intact = verify.statusCode === 200 && (v.ok === true || v.valid === true);
    reg(
      'AUDIT',
      'integrity chain verifies intact',
      'SPEC-AUDIT-1',
      'intact',
      JSON.stringify(v),
      intact,
    );
    expect(intact).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I. Observability endpoints (SPEC-OBS-1).
// ---------------------------------------------------------------------------
describe('I. Observability', () => {
  it('health/ready/metrics are open and shaped', async () => {
    const health = await hit(authed.app, 'GET', '/health');
    const hj = health.json() as Record<string, unknown>;
    const okHealth =
      health.statusCode === 200 && 'status' in hj && 'allowedTargets' in hj && 'authRequired' in hj;
    reg(
      'OBS',
      '/health open + shaped',
      'SPEC-OBS-1',
      '200 + fields',
      String(health.statusCode),
      okHealth,
    );
    expect(okHealth).toBe(true);

    const ready = await hit(authed.app, 'GET', '/ready');
    reg(
      'OBS',
      '/ready open',
      'SPEC-OBS-1',
      '200',
      String(ready.statusCode),
      ready.statusCode === 200,
    );
    expect(ready.statusCode).toBe(200);

    const metrics = await hit(authed.app, 'GET', '/metrics');
    reg(
      'OBS',
      '/metrics open',
      'SPEC-OBS-1',
      '200',
      String(metrics.statusCode),
      metrics.statusCode === 200,
    );
    expect(metrics.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// J. Login & anti-brute-force (SPEC auth).
// ---------------------------------------------------------------------------
describe('J. Login', () => {
  it('validates inputs, rejects bad credentials, locks out after repeated failures', async () => {
    const noEmail = await hit(authed.app, 'POST', '/api/auth/login', { body: { password: 'x' } });
    reg(
      'LOGIN',
      'missing email → 400',
      'input validation',
      '400',
      String(noEmail.statusCode),
      noEmail.statusCode === 400,
    );
    expect(noEmail.statusCode).toBe(400);

    const noPw = await hit(authed.app, 'POST', '/api/auth/login', { body: { email: 'off@wedos' } });
    reg(
      'LOGIN',
      'missing password → 400',
      'input validation',
      '400',
      String(noPw.statusCode),
      noPw.statusCode === 400,
    );
    expect(noPw.statusCode).toBe(400);

    const ok = await hit(authed.app, 'POST', '/api/auth/login', {
      body: { email: CREDS.ciso.email, password: CREDS.ciso.pw },
    });
    const gotToken = ok.statusCode === 200 && typeof ok.json().token === 'string';
    reg(
      'LOGIN',
      'valid credentials → token',
      'SPEC-RBAC-1',
      '200 + token',
      String(ok.statusCode),
      gotToken,
    );
    expect(gotToken).toBe(true);

    const bad = await hit(authed.app, 'POST', '/api/auth/login', {
      body: { email: 'off@wedos', password: 'wrong' },
    });
    reg(
      'LOGIN',
      'wrong password → 401',
      'SPEC-RBAC-1',
      '401',
      String(bad.statusCode),
      bad.statusCode === 401,
    );
    expect(bad.statusCode).toBe(401);

    // Lockout after 5 failures for a dedicated key.
    const victim = 'lockme@wedos';
    for (let i = 0; i < 5; i++) {
      await hit(authed.app, 'POST', '/api/auth/login', {
        body: { email: victim, password: 'nope' },
      });
    }
    const locked = await hit(authed.app, 'POST', '/api/auth/login', {
      body: { email: victim, password: 'nope' },
    });
    reg(
      'LOGIN',
      'lockout after 5 failures → 429',
      'anti-brute-force',
      '429',
      String(locked.statusCode),
      locked.statusCode === 429,
    );
    expect(locked.statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// K. Read-token routes (browser links: report/CSV/compliance). SPEC-RBAC-2.
// ---------------------------------------------------------------------------
describe('K. Read-token routes', () => {
  const routes = [
    '/api/runs.csv',
    '/api/reports/compliance',
    '/api/suites/nope/report',
    '/api/runs/nope/report',
    '/api/runs/nope/timeline.csv',
  ];
  it('require a read token; accept it via header or query for any read role', async () => {
    for (const u of routes) {
      const noTok = await hit(authed.app, 'GET', u);
      reg(
        'RTOKEN',
        `no token ${u}`,
        'SPEC-RBAC-2',
        '401',
        String(noTok.statusCode),
        noTok.statusCode === 401,
      );
      expect(noTok.statusCode, `no-token ${u}`).toBe(401);

      const hdr = await hit(authed.app, 'GET', u, { token: authed.tokens.viewer });
      reg(
        'RTOKEN',
        `header token ${u}`,
        'SPEC-RBAC-2',
        'not 401',
        String(hdr.statusCode),
        hdr.statusCode !== 401,
      );
      expect(hdr.statusCode, `header ${u}`).not.toBe(401);

      const sep = u.includes('?') ? '&' : '?';
      const qry = await hit(authed.app, 'GET', `${u}${sep}token=${authed.tokens.ciso}`);
      reg(
        'RTOKEN',
        `query token ${u}`,
        'SPEC-RBAC-2',
        'not 401',
        String(qry.statusCode),
        qry.statusCode !== 401,
      );
      expect(qry.statusCode, `query ${u}`).not.toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// L. Unknown routes & methods.
// ---------------------------------------------------------------------------
describe('L. Unknown routes & methods', () => {
  it('unmatched routes/methods return 404', async () => {
    const cases: [Method, string][] = [
      ['GET', '/api/does-not-exist'],
      ['DELETE', '/api/campaigns/nope'],
      ['PUT', '/api/campaigns'],
      ['GET', '/api/../etc'],
    ];
    for (const [m, u] of cases) {
      const res = await hit(authed.app, m, u, { token: authed.tokens.ciso });
      const pass = res.statusCode === 404;
      reg('ROUTE', `${m} ${u} → 404`, 'routing', '404', String(res.statusCode), pass);
      expect(pass, `${m} ${u} → ${res.statusCode}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// M. Approval decision variants (SPEC-SOD-1, lifecycle).
// ---------------------------------------------------------------------------
describe('M. Approval decisions', () => {
  async function pending(): Promise<string> {
    const r = await hit(authed.app, 'POST', '/api/campaigns', {
      token: authed.tokens.engineer,
      body: campaign(),
    });
    return (r.json() as { id: string }).id;
  }
  it('reject with a reason moves the campaign to REJECTED', async () => {
    const id = await pending();
    const res = await hit(authed.app, 'POST', `/api/campaigns/${id}/approval`, {
      token: authed.tokens.ciso,
      body: { decision: 'REJECTED', approvedBy: CREDS.ciso.email, reason: 'out of scope' },
    });
    const rejected =
      res.statusCode === 200 && (res.json() as { status?: string }).status === 'REJECTED';
    reg(
      'APPR',
      'reject with reason → REJECTED',
      'SPEC-SOD-1',
      '200 REJECTED',
      `${res.statusCode} ${(res.json() as { status?: string }).status}`,
      rejected,
    );
    expect(rejected).toBe(true);
  });

  it('an approved campaign cannot be re-approved (no double transition)', async () => {
    const id = await pending();
    await hit(authed.app, 'POST', `/api/campaigns/${id}/approval`, {
      token: authed.tokens.ciso,
      body: { decision: 'APPROVED', approvedBy: CREDS.ciso.email },
    });
    const again = await hit(authed.app, 'POST', `/api/campaigns/${id}/approval`, {
      token: authed.tokens.ciso,
      body: { decision: 'APPROVED', approvedBy: CREDS.ciso.email },
    });
    const blocked = again.statusCode >= 400 && again.statusCode < 500;
    reg(
      'APPR',
      're-approving an approved campaign is rejected',
      'lifecycle',
      '4xx',
      String(again.statusCode),
      blocked,
    );
    expect(blocked, `re-approve → ${again.statusCode}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N. Scenario / flow / recurrence validation (SPEC-CAP-1, bounds).
// ---------------------------------------------------------------------------
describe('N. Scenario / flow / recurrence', () => {
  interface NC {
    title: string;
    over: Record<string, unknown>;
    want: 201 | 400;
    spec: string;
  }
  const okFlow = Array.from({ length: 20 }, () => ({ method: 'GET', url: 'http://127.0.0.1/' }));
  const bigFlow = Array.from({ length: 21 }, () => ({ method: 'GET', url: 'http://127.0.0.1/' }));
  const cases: NC[] = [
    {
      title: 'valid 2-phase scenario',
      over: {
        scenario: [
          { maxRps: 10, durationSec: 3 },
          { maxRps: 20, durationSec: 3 },
        ],
      },
      want: 201,
      spec: 'SPEC-CAP-1',
    },
    {
      title: 'scenario phase maxRps > cap',
      over: { scenario: [{ maxRps: 2001, durationSec: 3 }] },
      want: 400,
      spec: 'SPEC-CAP-1',
    },
    {
      title: 'scenario phase maxRps 0',
      over: { scenario: [{ maxRps: 0, durationSec: 3 }] },
      want: 400,
      spec: 'SPEC-CAP-1',
    },
    {
      title: 'scenario total duration > cap',
      over: { scenario: [{ maxRps: 10, durationSec: 901 }] },
      want: 400,
      spec: 'SPEC-CAP-1',
    },
    {
      title: 'scenario > 12 phases',
      over: { scenario: Array.from({ length: 13 }, () => ({ maxRps: 10, durationSec: 1 })) },
      want: 400,
      spec: 'bounds',
    },
    {
      title: 'flow at the 20-step limit',
      over: { flow: okFlow },
      want: 201,
      spec: 'MAX_FLOW_STEPS',
    },
    {
      title: 'flow over the 20-step limit',
      over: { flow: bigFlow },
      want: 400,
      spec: 'MAX_FLOW_STEPS',
    },
    {
      title: 'flow step with a bad method',
      over: { flow: [{ method: 'FETCH', url: 'http://127.0.0.1/' }] },
      want: 400,
      spec: 'flow validation',
    },
    {
      title: 'valid recurrence (15 min)',
      over: { recurrence: { intervalMin: 15 } },
      want: 201,
      spec: 'MIN_RECURRENCE_MIN',
    },
    {
      title: 'recurrence below the minimum',
      over: { recurrence: { intervalMin: 5 } },
      want: 400,
      spec: 'MIN_RECURRENCE_MIN',
    },
    {
      title: 'recurrence non-integer interval',
      over: { recurrence: { intervalMin: 15.5 } },
      want: 400,
      spec: 'bounds',
    },
    {
      title: 'recurrence until in the past',
      over: { recurrence: { intervalMin: 15, until: '2000-01-01T00:00:00Z' } },
      want: 400,
      spec: 'bounds',
    },
  ];
  it('scenario, flow and recurrence bounds are enforced', async () => {
    for (const c of cases) {
      const res = await hit(authed.app, 'POST', '/api/campaigns', {
        token: authed.tokens.engineer,
        body: campaign(c.over),
      });
      const pass = res.statusCode === c.want;
      reg('BOUNDS', c.title, c.spec, String(c.want), String(res.statusCode), pass);
      expect(pass, `${c.title} → ${res.statusCode} (want ${c.want})`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// O. Round-trips & accepted variations (positive coverage).
// ---------------------------------------------------------------------------
describe('O. Round-trips & accepted variations', () => {
  it('login: valid engineer/viewer succeed, unknown user is 401', async () => {
    for (const role of ['engineer', 'viewer'] as RoleKey[]) {
      const r = await hit(authed.app, 'POST', '/api/auth/login', {
        body: { email: CREDS[role].email, password: CREDS[role].pw },
      });
      const ok = r.statusCode === 200 && (r.json() as { role?: string }).role === CREDS[role].role;
      reg(
        'EXTRA',
        `login ${role} → token with role`,
        'SPEC-RBAC-1',
        '200 + role',
        String(r.statusCode),
        ok,
      );
      expect(ok).toBe(true);
    }
    const unknown = await hit(authed.app, 'POST', '/api/auth/login', {
      body: { email: 'ghost@wedos', password: 'whatever' },
    });
    reg(
      'EXTRA',
      'login unknown user → 401',
      'SPEC-RBAC-1',
      '401',
      String(unknown.statusCode),
      unknown.statusCode === 401,
    );
    expect(unknown.statusCode).toBe(401);
  });

  it('create → GET by id round-trips, and the campaign appears in the list', async () => {
    const created = await hit(authed.app, 'POST', '/api/campaigns', {
      token: authed.tokens.engineer,
      body: campaign({ name: 'roundtrip' }),
    });
    const id = (created.json() as { id: string }).id;
    const byId = await hit(authed.app, 'GET', `/api/campaigns/${id}`, {
      token: authed.tokens.viewer,
    });
    const roundtrip = byId.statusCode === 200 && (byId.json() as { id: string }).id === id;
    reg(
      'EXTRA',
      'GET /api/campaigns/:id round-trips',
      'SPEC-LIFE-1',
      '200 same id',
      String(byId.statusCode),
      roundtrip,
    );
    expect(roundtrip).toBe(true);

    const list = await hit(authed.app, 'GET', '/api/campaigns', { token: authed.tokens.viewer });
    const inList = (list.json() as { id: string }[]).some((c) => c.id === id);
    reg(
      'EXTRA',
      'new campaign appears in the list',
      'SPEC-LIFE-1',
      'present',
      String(inList),
      inList,
    );
    expect(inList).toBe(true);

    const pending = (byId.json() as { status: string }).status === 'PENDING_APPROVAL';
    reg(
      'EXTRA',
      'a new campaign is PENDING_APPROVAL',
      'SPEC-LIFE-1',
      'PENDING_APPROVAL',
      (byId.json() as { status: string }).status,
      pending,
    );
    expect(pending).toBe(true);
  });

  it('accepted campaign variations (vectors, headers, UAs, dataset, assertion)', async () => {
    const variations: [string, Record<string, unknown>][] = [
      ['vector http-get', { vector: 'http-get' }],
      ['vector http-post with body', { vector: 'http-post', body: '{"x":1}' }],
      ['custom headers', { headers: { 'x-test': 'y' } }],
      ['user-agent rotation', { userAgents: ['UA-1', 'UA-2'] }],
      ['data feeder dataset', { dataset: [{ q: 'a' }, { q: 'b' }] }],
      ['response assertion', { assertion: { status: 200 } }],
      ['acceptance SLO criteria', { acceptance: { maxP95Ms: 500, minWrs: 50 } }],
    ];
    for (const [title, over] of variations) {
      const res = await hit(authed.app, 'POST', '/api/campaigns', {
        token: authed.tokens.engineer,
        body: campaign(over),
      });
      const pass = res.statusCode === 201;
      reg('EXTRA', title, 'accepted variation', '201', String(res.statusCode), pass);
      expect(pass, `${title} → ${res.statusCode}`).toBe(true);
    }
  });

  it('auth disabled: createdBy comes from the request body (no identity override)', async () => {
    const res = await hit(open, 'POST', '/api/campaigns', {
      body: campaign({ createdBy: 'ext@somewhere' }),
    });
    const kept =
      res.statusCode === 201 &&
      (res.json() as { createdBy?: string }).createdBy === 'ext@somewhere';
    reg(
      'EXTRA',
      'auth-off keeps body createdBy',
      'SPEC-RBAC-3',
      'ext@somewhere',
      `${res.statusCode} ${(res.json() as { createdBy?: string }).createdBy}`,
      kept,
    );
    expect(kept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared: run one bounded campaign end-to-end (create → approve → execute).
// ---------------------------------------------------------------------------
async function runOne(): Promise<{ id: string; runId: string }> {
  const created = await hit(authed.app, 'POST', '/api/campaigns', {
    token: authed.tokens.engineer,
    body: campaign({ maxDurationSec: 1 }),
  });
  const id = (created.json() as { id: string }).id;
  await hit(authed.app, 'POST', `/api/campaigns/${id}/approval`, {
    token: authed.tokens.ciso,
    body: { decision: 'APPROVED', approvedBy: CREDS.ciso.email },
  });
  const run = await hit(authed.app, 'POST', `/api/campaigns/${id}/execute`, {
    token: authed.tokens.engineer,
  });
  return { id, runId: (run.json() as { runId: string }).runId };
}
let sharedRun: { id: string; runId: string } | null = null;
async function ensureRun(): Promise<{ id: string; runId: string }> {
  if (!sharedRun) sharedRun = await runOne();
  return sharedRun;
}

// ---------------------------------------------------------------------------
// P. Exports & reports (SPEC-LIFE-4, catalog E2/E4/E5/E6/E7/E8).
// ---------------------------------------------------------------------------
describe('P. Exports & reports', () => {
  itE2E(
    'a completed run exposes its detail, report, CSVs, WRS history and compliance',
    async () => {
      const { runId } = await ensureRun();
      const t = authed.tokens.ciso;

      const runs = await hit(authed.app, 'GET', '/api/runs', { token: t });
      const inRuns = (runs.json() as { runId: string }[]).some((r) => r.runId === runId);
      reg(
        'EXPORT',
        'GET /api/runs includes the run',
        'SPEC-LIFE-4',
        'present',
        String(inRuns),
        inRuns,
      );
      expect(inRuns).toBe(true);

      const byId = await hit(authed.app, 'GET', `/api/runs/${runId}`, { token: t });
      const run = byId.json() as { status: string; wrs?: { estimated?: boolean } };
      const detailOk = byId.statusCode === 200 && !!run.wrs;
      reg(
        'EXPORT',
        'GET /api/runs/:id → 200 with WRS',
        'E2',
        '200 + wrs',
        String(byId.statusCode),
        detailOk,
      );
      expect(detailOk).toBe(true);

      const estimated = run.wrs?.estimated === true;
      reg(
        'EXPORT',
        'WRS marked estimated (no protection source)',
        'E4',
        'estimated=true',
        String(run.wrs?.estimated),
        estimated,
      );
      expect(estimated).toBe(true);

      const html = (r: { statusCode: number; headers: Record<string, unknown> }) =>
        r.statusCode === 200 && String(r.headers['content-type'] ?? '').includes('text/html');
      const csv = (r: { statusCode: number; headers: Record<string, unknown> }) =>
        r.statusCode === 200 && String(r.headers['content-type'] ?? '').includes('csv');

      const report = await hit(authed.app, 'GET', `/api/runs/${runId}/report?token=${t}`);
      reg(
        'EXPORT',
        'run report HTML',
        'E2',
        '200 text/html',
        String(report.statusCode),
        html(report),
      );
      expect(html(report)).toBe(true);

      const timeline = await hit(authed.app, 'GET', `/api/runs/${runId}/timeline.csv?token=${t}`);
      reg(
        'EXPORT',
        'run timeline CSV',
        'E6',
        '200 csv',
        String(timeline.statusCode),
        csv(timeline),
      );
      expect(csv(timeline)).toBe(true);

      const runsCsv = await hit(authed.app, 'GET', `/api/runs.csv?token=${t}`);
      reg('EXPORT', 'runs.csv export', 'E5', '200 csv', String(runsCsv.statusCode), csv(runsCsv));
      expect(csv(runsCsv)).toBe(true);

      const compliance = await hit(authed.app, 'GET', `/api/reports/compliance?token=${t}`);
      reg(
        'EXPORT',
        'compliance report',
        'E8',
        '200 text/html',
        String(compliance.statusCode),
        html(compliance),
      );
      expect(html(compliance)).toBe(true);

      const hist = await hit(authed.app, 'GET', '/api/wrs/history', { token: t });
      const hasHistory = hist.statusCode === 200 && Array.isArray(hist.json());
      reg(
        'EXPORT',
        'WRS history returns a series',
        'E7',
        '200 array',
        String(hist.statusCode),
        hasHistory,
      );
      expect(hasHistory).toBe(true);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// Q. Audit export & growth (SPEC-AUDIT-1, catalog F4/F5).
// ---------------------------------------------------------------------------
describe('Q. Audit export & growth', () => {
  it('the trail grows with activity and exports', async () => {
    const t = authed.tokens.ciso;
    const len = async () =>
      ((await hit(authed.app, 'GET', '/api/audit', { token: t })).json() as unknown[]).length;
    const before = await len();
    await hit(authed.app, 'POST', '/api/campaigns', {
      token: authed.tokens.engineer,
      body: campaign(),
    });
    const after = await len();
    reg(
      'AUDIT',
      'trail grows after an audited action',
      'SPEC-AUDIT-1',
      'after > before',
      `${before}→${after}`,
      after > before,
    );
    expect(after).toBeGreaterThan(before);

    const exp = await hit(authed.app, 'GET', '/api/audit/export', { token: t });
    reg(
      'AUDIT',
      'audit export → 200',
      'SPEC-AUDIT-1',
      '200',
      String(exp.statusCode),
      exp.statusCode === 200,
    );
    expect(exp.statusCode).toBe(200);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// R. Playbooks & suites (catalog G1/G2/G3/G4/G5/G6).
// ---------------------------------------------------------------------------
describe('R. Playbooks & suites', () => {
  it('CRUD + instantiate + suite report', async () => {
    const t = authed.tokens.engineer;
    const list = await hit(authed.app, 'GET', '/api/playbooks', { token: t });
    const curated = (list.json() as { custom: boolean }[]).some((p) => p.custom === false);
    reg(
      'PLAYBK',
      'built-in playbooks are listed',
      'G1',
      'curated present',
      String(curated),
      curated,
    );
    expect(curated).toBe(true);

    const created = await hit(authed.app, 'POST', '/api/playbooks', {
      token: t,
      body: {
        name: 'cat-pb',
        steps: [{ maxRps: 10, concurrency: 2, maxDurationSec: 5, profile: 'constant' }],
      },
    });
    const pbId = (created.json() as { id: string }).id;
    const createdOk = created.statusCode === 201 && pbId.startsWith('custom-');
    reg(
      'PLAYBK',
      'create a custom playbook',
      'G2',
      '201 custom-*',
      `${created.statusCode} ${pbId}`,
      createdOk,
    );
    expect(createdOk).toBe(true);

    const empty = await hit(authed.app, 'POST', '/api/playbooks', {
      token: t,
      body: { name: 'x', steps: [] },
    });
    reg(
      'PLAYBK',
      'empty-steps playbook rejected',
      'G2',
      '400',
      String(empty.statusCode),
      empty.statusCode === 400,
    );
    expect(empty.statusCode).toBe(400);

    const delBuiltin = await hit(authed.app, 'DELETE', '/api/playbooks/builtin-x', { token: t });
    reg(
      'PLAYBK',
      'built-in playbook not deletable',
      'G4',
      '400',
      String(delBuiltin.statusCode),
      delBuiltin.statusCode === 400,
    );
    expect(delBuiltin.statusCode).toBe(400);

    const inst = await hit(authed.app, 'POST', `/api/playbooks/${pbId}/instantiate`, {
      token: t,
      body: { target: 'http://127.0.0.1/' },
    });
    reg(
      'PLAYBK',
      'instantiate a custom playbook',
      'G5',
      '2xx',
      String(inst.statusCode),
      inst.statusCode < 300,
    );
    expect(inst.statusCode).toBeLessThan(300);

    const inst404 = await hit(authed.app, 'POST', '/api/playbooks/nope/instantiate', {
      token: t,
      body: { target: 'http://127.0.0.1/' },
    });
    reg(
      'PLAYBK',
      'instantiate unknown playbook → 404',
      'SPEC-LIFE-3',
      '404',
      String(inst404.statusCode),
      inst404.statusCode === 404,
    );
    expect(inst404.statusCode).toBe(404);

    const suites = await hit(authed.app, 'GET', '/api/suites', { token: t });
    const suiteList = suites.json() as { suiteId: string }[];
    const hasSuite = suiteList.length > 0;
    reg(
      'PLAYBK',
      'a suite appears after instantiation',
      'G6',
      'suites > 0',
      String(suiteList.length),
      hasSuite,
    );
    expect(hasSuite).toBe(true);

    const sid = suiteList[0].suiteId;
    const sById = await hit(authed.app, 'GET', `/api/suites/${sid}`, { token: t });
    reg(
      'PLAYBK',
      'GET /api/suites/:id → 200',
      'G6',
      '200',
      String(sById.statusCode),
      sById.statusCode === 200,
    );
    expect(sById.statusCode).toBe(200);

    const sReport = await hit(authed.app, 'GET', `/api/suites/${sid}/report?token=${t}`);
    const repOk =
      sReport.statusCode === 200 &&
      String(sReport.headers['content-type'] ?? '').includes('text/html');
    reg('PLAYBK', 'suite report HTML', 'G6', '200 text/html', String(sReport.statusCode), repOk);
    expect(repOk).toBe(true);

    const del = await hit(authed.app, 'DELETE', `/api/playbooks/${pbId}`, { token: t });
    reg(
      'PLAYBK',
      'delete a custom playbook → 200',
      'G4',
      '200',
      String(del.statusCode),
      del.statusCode === 200,
    );
    expect(del.statusCode).toBe(200);

    const del2 = await hit(authed.app, 'DELETE', `/api/playbooks/${pbId}`, { token: t });
    reg(
      'PLAYBK',
      're-delete → 404',
      'SPEC-LIFE-3',
      '404',
      String(del2.statusCode),
      del2.statusCode === 404,
    );
    expect(del2.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// S. User lifecycle (catalog H3/H4/H5).
// ---------------------------------------------------------------------------
describe('S. User lifecycle', () => {
  it('create → login → role change → delete → login fails; self/env protected', async () => {
    const t = authed.tokens.admin;
    const email = `life-${Math.random().toString(36).slice(2)}@wedos`;
    const pw = 'strong-pass-123';

    const create = await hit(authed.app, 'POST', '/api/users', {
      token: t,
      body: { email, role: 'viewer', password: pw },
    });
    reg(
      'ULIFE',
      'create a store user',
      'SPEC-USER-1',
      '201',
      String(create.statusCode),
      create.statusCode === 201,
    );
    expect(create.statusCode).toBe(201);

    const login1 = await hit(authed.app, 'POST', '/api/auth/login', {
      body: { email, password: pw },
    });
    const asViewer =
      login1.statusCode === 200 && (login1.json() as { role: string }).role === 'viewer';
    reg(
      'ULIFE',
      'the new user can log in',
      'SPEC-USER-1',
      '200 viewer',
      String(login1.statusCode),
      asViewer,
    );
    expect(asViewer).toBe(true);

    const patch = await hit(authed.app, 'PATCH', `/api/users/${encodeURIComponent(email)}`, {
      token: t,
      body: { role: 'engineer' },
    });
    const patched =
      patch.statusCode === 200 && (patch.json() as { role: string }).role === 'engineer';
    reg('ULIFE', 'change the user’s role', 'H4', '200 engineer', String(patch.statusCode), patched);
    expect(patched).toBe(true);

    const login2 = await hit(authed.app, 'POST', '/api/auth/login', {
      body: { email, password: pw },
    });
    const nowEngineer = (login2.json() as { role: string }).role === 'engineer';
    reg(
      'ULIFE',
      'role change takes effect at next login',
      'H4',
      'engineer',
      String((login2.json() as { role: string }).role),
      nowEngineer,
    );
    expect(nowEngineer).toBe(true);

    const patchSelf = await hit(
      authed.app,
      'PATCH',
      `/api/users/${encodeURIComponent(CREDS.ciso.email)}`,
      { token: t, body: { role: 'viewer' } },
    );
    reg(
      'ULIFE',
      'cannot modify your own / an env account',
      'SPEC-USER-2',
      '400',
      String(patchSelf.statusCode),
      patchSelf.statusCode === 400,
    );
    expect(patchSelf.statusCode).toBe(400);

    const del = await hit(authed.app, 'DELETE', `/api/users/${encodeURIComponent(email)}`, {
      token: t,
    });
    reg(
      'ULIFE',
      'delete the store user',
      'SPEC-USER-1',
      '200',
      String(del.statusCode),
      del.statusCode === 200,
    );
    expect(del.statusCode).toBe(200);

    const login3 = await hit(authed.app, 'POST', '/api/auth/login', {
      body: { email, password: pw },
    });
    reg(
      'ULIFE',
      'deleted user can no longer log in',
      'SPEC-USER-1',
      '401',
      String(login3.statusCode),
      login3.statusCode === 401,
    );
    expect(login3.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// T. Rejection reason & post-run state (catalog C5/D7).
// ---------------------------------------------------------------------------
describe('T. Rejection & post-run', () => {
  it('a rejection records its reason on the campaign', async () => {
    const created = await hit(authed.app, 'POST', '/api/campaigns', {
      token: authed.tokens.engineer,
      body: campaign(),
    });
    const id = (created.json() as { id: string }).id;
    await hit(authed.app, 'POST', `/api/campaigns/${id}/approval`, {
      token: authed.tokens.ciso,
      body: {
        decision: 'REJECTED',
        approvedBy: CREDS.ciso.email,
        reason: 'out-of-scope-target',
      },
    });
    const c = (
      await hit(authed.app, 'GET', `/api/campaigns/${id}`, { token: authed.tokens.viewer })
    ).json() as {
      status: string;
      approvalReason?: string;
    };
    const ok = c.status === 'REJECTED' && c.approvalReason === 'out-of-scope-target';
    reg(
      'REJECT',
      'rejection reason is persisted and readable',
      'C5',
      'REJECTED + reason',
      `${c.status} / ${c.approvalReason}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  itE2E(
    'killing an already-finished campaign is 404 (no active run)',
    async () => {
      const { id } = await ensureRun();
      const k = await hit(authed.app, 'POST', `/api/campaigns/${id}/kill`, {
        token: authed.tokens.viewer,
      });
      reg(
        'POSTRUN',
        'kill a finished campaign → 404',
        'SPEC-LIFE-3',
        '404',
        String(k.statusCode),
        k.statusCode === 404,
      );
      expect(k.statusCode).toBe(404);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// V. Campaign shapes — every campaign type, created and (representatively) run
// end-to-end against a live local target so feature signals are real.
// ---------------------------------------------------------------------------
describe('V. Campaign shapes (all campaign types)', () => {
  let base: string;
  const seenPaths = new Set<string>();
  const seenUAs = new Set<string>();
  const server = createServer((req, res) => {
    seenPaths.add(req.url ?? '');
    if (req.headers['user-agent']) seenUAs.add(String(req.headers['user-agent']));
    if ((req.url ?? '').startsWith('/login')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'T-123' }));
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const mk = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    campaign({ target: `${base}/`, probeUrl: `${base}/`, maxDurationSec: 1, ...over });
  const create = (over: Record<string, unknown> = {}, token = authed.tokens.engineer) =>
    hit(authed.app, 'POST', '/api/campaigns', { token, body: mk(over) });

  async function runShape(over: Record<string, unknown>): Promise<{
    status: number;
    run: { status: string; generator: { totalRequests: number; assertionsChecked?: number } };
  }> {
    const c = (await create(over)).json() as { id: string };
    await hit(authed.app, 'POST', `/api/campaigns/${c.id}/approval`, {
      token: authed.tokens.ciso,
      body: { decision: 'APPROVED', approvedBy: CREDS.ciso.email },
    });
    const res = await hit(authed.app, 'POST', `/api/campaigns/${c.id}/execute`, {
      token: authed.tokens.engineer,
    });
    return { status: res.statusCode, run: res.json() as never };
  }

  it('every campaign shape is accepted at creation (201)', async () => {
    const shapes: [string, Record<string, unknown>][] = [
      ['http-get', { vector: 'http-get' }],
      ['http-post + body', { vector: 'http-post', body: '{"x":1}' }],
      [
        'multi-phase scenario',
        {
          scenario: [
            { maxRps: 10, durationSec: 2 },
            { maxRps: 20, durationSec: 2 },
          ],
        },
      ],
      [
        'multi-step flow',
        {
          flow: [
            { method: 'GET', url: `${base}/a` },
            { method: 'GET', url: `${base}/b` },
          ],
        },
      ],
      [
        'flow with correlation',
        {
          flow: [
            {
              method: 'GET',
              url: `${base}/login`,
              extract: { name: 'tok', from: 'json', expr: 'token' },
            },
            { method: 'GET', url: `${base}/data?t={{tok}}` },
          ],
        },
      ],
      [
        'endpoint mix',
        {
          endpoints: [
            { url: `${base}/a`, weight: 1 },
            { url: `${base}/b`, weight: 1 },
          ],
        },
      ],
      ['user-agent rotation', { userAgents: ['UA-One', 'UA-Two'] }],
      ['data feeder', { target: `${base}/s?q={{q}}`, dataset: [{ q: 'alpha' }, { q: 'beta' }] }],
      ['response assertion', { assertion: { status: 200 } }],
      ['acceptance SLO', { acceptance: { maxP95Ms: 500, minWrs: 50 } }],
      ['recurring', { recurrence: { intervalMin: 15 } }],
      ['scheduled', { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }],
      ['engine builtin', { agent: 'builtin' }],
      ['engine k6', { agent: 'k6' }],
      ['engine vegeta', { agent: 'vegeta' }],
      ['engine locust', { agent: 'locust' }],
      ['engine jmeter', { agent: 'jmeter' }],
      ['engine gatling', { agent: 'gatling' }],
    ];
    for (const [title, over] of shapes) {
      const res = await create(over);
      const pass = res.statusCode === 201;
      reg('SHAPE', `create: ${title}`, 'campaign shapes', '201', String(res.statusCode), pass);
      expect(pass, `${title} → ${res.statusCode}`).toBe(true);
    }
  });

  it('engine capability conflicts are rejected (400)', async () => {
    const conflicts: [string, Record<string, unknown>][] = [
      [
        'endpoint mix requires an endpoint-capable engine',
        { agent: 'locust', endpoints: [{ url: `${base}/a`, weight: 1 }] },
      ],
      ['UA rotation requires builtin', { agent: 'k6', userAgents: ['A', 'B'] }],
      ['data feeder requires builtin', { agent: 'k6', dataset: [{ q: 'a' }] }],
      ['assertions require builtin', { agent: 'k6', assertion: { status: 200 } }],
      [
        'multi-phase needs a capable engine',
        {
          agent: 'gatling',
          scenario: [
            { maxRps: 10, durationSec: 2 },
            { maxRps: 20, durationSec: 2 },
          ],
        },
      ],
      // NOTE: correlation on k6 is NO LONGER a conflict — k6 is now
      // correlation-capable (P6), so an authenticated journey runs at high rate.
      ['unknown engine', { agent: 'nope-engine' }],
    ];
    for (const [title, over] of conflicts) {
      const res = await create(over);
      const pass = res.statusCode === 400;
      reg('SHAPE', `reject: ${title}`, 'engine capabilities', '400', String(res.statusCode), pass);
      expect(pass, `${title} → ${res.statusCode}`).toBe(true);
    }
    // Positive: a correlation flow on k6 is now ACCEPTED (P6 — k6 is correlation-capable).
    const ok = await create({
      agent: 'k6',
      flow: [
        {
          method: 'GET',
          url: `${base}/login`,
          extract: { name: 'tok', from: 'json', expr: 'token' },
        },
        { method: 'GET', url: `${base}/d?t={{tok}}` },
      ],
    });
    expect(ok.statusCode, `correlation on k6 accepted → ${ok.statusCode}`).toBe(201);
  });

  itE2E(
    'representative shapes run end-to-end to COMPLETED with their feature signal',
    async () => {
      // A) builtin features together: assertion + UA rotation + data feeder.
      const a = await runShape({
        target: `${base}/s?q={{q}}`,
        dataset: [{ q: 'alpha' }, { q: 'beta' }],
        userAgents: ['UA-One', 'UA-Two'],
        assertion: { status: 200 },
      });
      const aOk =
        a.status === 201 &&
        a.run.status === 'COMPLETED' &&
        (a.run.generator.assertionsChecked ?? 0) > 0;
      reg(
        'SHAPE',
        'run: assertion+UA+dataset → COMPLETED, assertions checked',
        'exec',
        'COMPLETED + checks>0',
        `${a.run.status}/${a.run.generator.assertionsChecked}`,
        aOk,
      );
      expect(aOk).toBe(true);
      reg(
        'SHAPE',
        'run: UA rotation hit the target with >1 UA',
        'exec',
        '≥2 UAs',
        String(seenUAs.size),
        seenUAs.has('UA-One') && seenUAs.has('UA-Two'),
      );
      expect(seenUAs.has('UA-One') && seenUAs.has('UA-Two')).toBe(true);
      reg(
        'SHAPE',
        'run: data feeder substituted the dataset value',
        'exec',
        'q=alpha seen',
        String([...seenPaths].some((p) => p.includes('q=alpha'))),
        [...seenPaths].some((p) => p.includes('q=alpha')),
      );
      expect([...seenPaths].some((p) => p.includes('q=alpha') || p.includes('q=beta'))).toBe(true);

      // B) endpoint mix spreads across both paths. Use enough requests
      // (maxRps × duration) that an equal-weight random split hits BOTH paths
      // deterministically — a handful of requests can miss one purely by chance.
      const b = await runShape({
        maxRps: 40,
        concurrency: 5,
        maxDurationSec: 2,
        endpoints: [
          { url: `${base}/mix-a`, weight: 1 },
          { url: `${base}/mix-b`, weight: 1 },
        ],
      });
      const bOk =
        b.run.status === 'COMPLETED' &&
        [...seenPaths].some((p) => p.includes('/mix-a')) &&
        [...seenPaths].some((p) => p.includes('/mix-b'));
      reg('SHAPE', 'run: endpoint mix hit both endpoints', 'exec', 'both paths', String(bOk), bOk);
      expect(bOk).toBe(true);

      // C) multi-phase scenario.
      const c = await runShape({
        scenario: [
          { maxRps: 10, durationSec: 1 },
          { maxRps: 20, durationSec: 1 },
        ],
      });
      reg(
        'SHAPE',
        'run: multi-phase scenario → COMPLETED',
        'exec',
        'COMPLETED',
        c.run.status,
        c.run.status === 'COMPLETED',
      );
      expect(c.run.status).toBe('COMPLETED');

      // D) multi-step flow with correlation.
      const d = await runShape({
        flow: [
          {
            method: 'GET',
            url: `${base}/login`,
            extract: { name: 'tok', from: 'json', expr: 'token' },
          },
          { method: 'GET', url: `${base}/flow-data?t={{tok}}` },
        ],
      });
      const dOk =
        d.run.status === 'COMPLETED' &&
        [...seenPaths].some((p) => p.startsWith('/login')) &&
        [...seenPaths].some((p) => p.startsWith('/flow-data'));
      reg(
        'SHAPE',
        'run: flow + correlation executed both steps',
        'exec',
        'login + data seen',
        String(dOk),
        dOk,
      );
      expect(dOk).toBe(true);

      // E) POST with a body.
      const e = await runShape({ vector: 'http-post', body: '{"x":1}' });
      reg(
        'SHAPE',
        'run: http-post → COMPLETED',
        'exec',
        'COMPLETED',
        e.run.status,
        e.run.status === 'COMPLETED',
      );
      expect(e.run.status).toBe('COMPLETED');

      // F) external engine selected but not installed → falls back to builtin and completes.
      const f = await runShape({ agent: 'k6' });
      reg(
        'SHAPE',
        'run: unavailable engine falls back to builtin → COMPLETED',
        'engine fallback',
        'COMPLETED',
        `${f.status}/${f.run.status}`,
        f.status === 201 && f.run.status === 'COMPLETED',
      );
      expect(f.status, `k6 fallback → ${f.status}`).toBe(201);
      expect(f.run.status).toBe('COMPLETED');
    },
    90_000,
  );
});

// ---------------------------------------------------------------------------
// Report writer — a durable, human-readable results table.
// ---------------------------------------------------------------------------
afterAll(() => {
  const total = results.length;
  const failed = results.filter((r) => !r.pass);
  const findings = results.filter((r) => r.outcome === 'FINDING');
  const byArea = new Map<string, { n: number; fail: number; find: number }>();
  for (const r of results) {
    const a = byArea.get(r.area) ?? { n: 0, fail: 0, find: 0 };
    a.n += 1;
    if (!r.pass) a.fail += 1;
    if (r.outcome === 'FINDING') a.find += 1;
    byArea.set(r.area, a);
  }

  const lines: string[] = [];
  lines.push('# Functional catalog — execution results');
  lines.push('');
  lines.push('Generated by `backend/test/catalog/catalog.test.ts`. Expected results are');
  lines.push('argued against `docs/test-catalog/specification.md`. Re-run: `npm test -w backend`.');
  lines.push('');
  lines.push(
    E2E
      ? '_End-to-end runs included (CATALOG_E2E=1)._'
      : '_End-to-end runs skipped — set `CATALOG_E2E=1` to include them (CI does)._',
  );
  lines.push('');
  lines.push(
    `**Total cases executed: ${total}** — passed ${total - failed.length}, failed ${failed.length}, findings ${findings.length}.`,
  );
  lines.push('');
  lines.push('## By area');
  lines.push('');
  lines.push('| Area | Cases | Failed | Findings |');
  lines.push('| ---- | ----: | -----: | -------: |');
  for (const [area, a] of [...byArea.entries()].sort()) {
    lines.push(`| ${area} | ${a.n} | ${a.fail} | ${a.find} |`);
  }
  lines.push('');
  if (findings.length) {
    lines.push('## Findings (behaviour diverges from the spec principle)');
    lines.push('');
    for (const f of findings) {
      lines.push(`- **${f.id} — ${f.title}** (${f.spec})`);
      lines.push(`  - expected: ${f.want}`);
      lines.push(`  - observed: ${f.got}`);
      if (f.note) lines.push(`  - note: ${f.note}`);
    }
    lines.push('');
  }
  if (failed.length) {
    lines.push('## Failures');
    lines.push('');
    for (const f of failed) {
      lines.push(`- **${f.id} — ${f.title}** (${f.spec}): want ${f.want}, got ${f.got}`);
    }
    lines.push('');
  }
  lines.push('## All cases');
  lines.push('');
  lines.push('| ID | Area | Case | Spec | Expected | Observed | Result |');
  lines.push('| -- | ---- | ---- | ---- | -------- | -------- | ------ |');
  for (const r of results) {
    const result = !r.pass ? '❌ FAIL' : r.outcome === 'FINDING' ? '⚠️ FINDING' : '✅';
    const esc = (s: string) => s.replace(/\|/g, '\\|');
    lines.push(
      `| ${r.id} | ${r.area} | ${esc(r.title)} | ${r.spec} | ${esc(r.want)} | ${esc(r.got)} | ${result} |`,
    );
  }
  lines.push('');

  // Write the durable report ONLY when explicitly asked (CATALOG_WRITE=1).
  // results.md is a tracked file; regenerating it on every `npm test` dirties
  // the working tree, which on a server breaks the next `git pull`
  // (deploy/update.sh uses `git reset --hard`, but a manual pull aborts). Refresh
  // it on demand: `CATALOG_WRITE=1 npm test -w backend`.
  if (process.env.CATALOG_WRITE === '1') {
    const out = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../docs/test-catalog/results.md',
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, lines.join('\n'));
  }
});
