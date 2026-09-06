import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
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

  it('kill switch is available to every role (SPEC-RBAC-4)', async () => {
    for (const role of ROLE_KEYS) {
      const res = await hit(authed.app, 'POST', '/api/campaigns/nope/kill', {
        token: authed.tokens[role],
      });
      const pass = res.statusCode !== 403; // reaches handler (404, no active run)
      reg(
        'RBAC',
        `${role} may use kill switch`,
        'SPEC-RBAC-4',
        'not 403',
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
      want: 201,
      outcome: 'FINDING',
      note: 'fractional rps accepted; a whole number would be expected',
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
      want: 201,
      outcome: 'FINDING',
      note: 'fractional concurrency accepted; integer expected',
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

  it('officer approves a campaign authored by the engineer (SoD satisfied)', async () => {
    const c = await createAs('engineer');
    const res = await approve('officer', c.id, CREDS.officer.email);
    const pass = res.statusCode === 200;
    reg(
      'SOD',
      'officer approves engineer’s campaign',
      'SPEC-SOD-1',
      '200',
      String(res.statusCode),
      pass,
    );
    expect(pass).toBe(true);
  });

  it('officer cannot approve their own campaign (author = approver)', async () => {
    const c = await createAs('officer');
    const res = await approve('officer', c.id, CREDS.officer.email);
    const pass = res.statusCode === 400;
    reg('SOD', 'self-approval blocked', 'SPEC-SOD-1', '400', String(res.statusCode), pass);
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
    const res = await approve('officer', 'does-not-exist', CREDS.officer.email);
    const pass = res.statusCode === 404;
    reg('SOD', 'approve unknown id', 'SPEC-LIFE-3', '404', String(res.statusCode), pass);
    expect(pass).toBe(true);
  });

  it('FINDING: the approver may also execute — SoD is only partial', async () => {
    // Officer approves a campaign they did not author, then runs it themselves.
    const c = await createAs('engineer', { maxDurationSec: 1 });
    await approve('officer', c.id, CREDS.officer.email);
    const run = await hit(authed.app, 'POST', `/api/campaigns/${c.id}/execute`, {
      token: authed.tokens.officer,
    });
    const executed = run.statusCode === 201;
    // Current behaviour: allowed. Argued ideal: the executor should differ from
    // the approver (or the concentration be a consciously accepted risk).
    reg(
      'SOD',
      'approver can also execute the same campaign',
      'SPEC-SOD-2',
      'ideally separated (executor ≠ approver)',
      executed ? 'same officer approved AND executed (200)' : `blocked (${run.statusCode})`,
      executed, // pin current behaviour so the suite stays green
      'FINDING',
      'SoD enforces author≠approver but not approver≠executor: one officer can approve then run a campaign end-to-end. Consider requiring a distinct executor, or document as an accepted risk.',
    );
    expect(executed).toBe(true);
  }, 20_000);
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
      token: authed.tokens.viewer,
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
  it('only the officer manages users; validation & immutability hold', async () => {
    // Non-officers are denied (already in the matrix, re-asserted for the area).
    for (const role of ['engineer', 'viewer'] as RoleKey[]) {
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
      token: authed.tokens.officer,
      body: { email, role: 'engineer', password: 'a-strong-password' },
    });
    reg(
      'USER',
      'officer creates a valid user',
      'SPEC-USER-1',
      '2xx',
      String(create.statusCode),
      create.statusCode < 300,
    );
    expect(create.statusCode).toBeLessThan(300);

    // Re-posting an existing store user is an UPSERT, not a 409.
    const dup = await hit(authed.app, 'POST', '/api/users', {
      token: authed.tokens.officer,
      body: { email, role: 'viewer', password: 'a-different-password' },
    });
    const isUpsert = dup.statusCode === 201;
    reg(
      'USER',
      're-creating an existing user overwrites it (upsert)',
      'SPEC-USER-1',
      'a pure create would 409',
      `${dup.statusCode} (upsert)`,
      isUpsert,
      'FINDING',
      'POST /api/users is create-or-update: re-posting an existing store user silently overwrites their role + password (audited as user.upsert). Acceptable as an idempotent admin upsert, but a "create" that resets an account without confirmation is worth surfacing.',
    );
    expect(isUpsert).toBe(true);

    // Weak password rejected.
    const weak = await hit(authed.app, 'POST', '/api/users', {
      token: authed.tokens.officer,
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
      token: authed.tokens.officer,
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
      `/api/users/${encodeURIComponent(CREDS.officer.email)}`,
      {
        token: authed.tokens.officer,
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
    const list = await hit(authed.app, 'GET', '/api/audit', { token: authed.tokens.officer });
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
      token: authed.tokens.officer,
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
      body: { email: CREDS.officer.email, password: CREDS.officer.pw },
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
      const qry = await hit(authed.app, 'GET', `${u}${sep}token=${authed.tokens.officer}`);
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
      const res = await hit(authed.app, m, u, { token: authed.tokens.officer });
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
      token: authed.tokens.officer,
      body: { decision: 'REJECTED', approvedBy: CREDS.officer.email, reason: 'out of scope' },
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
      token: authed.tokens.officer,
      body: { decision: 'APPROVED', approvedBy: CREDS.officer.email },
    });
    const again = await hit(authed.app, 'POST', `/api/campaigns/${id}/approval`, {
      token: authed.tokens.officer,
      body: { decision: 'APPROVED', approvedBy: CREDS.officer.email },
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

  const out = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../docs/test-catalog/results.md',
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'));
});
