import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

/**
 * RBAC matrix: every (role × endpoint) resolves to the expected authorization
 * outcome for the four effective roles — engineer (create + launch), ciso
 * (approve), admin (administer users/limits), viewer (read only). Non-existent
 * ids exercise the guard (403) without running load; an authorized role instead
 * reaches the handler (404).
 */

const allowed = ['127.0.0.1', 'localhost'];
const creds = {
  engineer: { email: 'eng@wedos', role: 'engineer', pw: 'pw-engineer-123' },
  ciso: { email: 'ciso@wedos', role: 'ciso', pw: 'pw-ciso-1234567' },
  admin: { email: 'admin@wedos', role: 'admin', pw: 'pw-admin-12345' },
  viewer: { email: 'view@wedos', role: 'viewer', pw: 'pw-viewer-123' },
} as const;
type RoleKey = keyof typeof creds;
const ROLE_KEYS = Object.keys(creds) as RoleKey[];

const campaignBody = {
  name: 'RBAC',
  target: 'http://127.0.0.1/',
  probeUrl: 'http://127.0.0.1/',
  vector: 'http-get',
  maxRps: 10,
  concurrency: 2,
  maxDurationSec: 10,
  authorized: true,
};

let app: FastifyInstance;
const tokens: Record<RoleKey, string> = { engineer: '', ciso: '', admin: '', viewer: '' };

beforeAll(async () => {
  const AUTH_USERS = JSON.stringify(
    Object.values(creds).map((u) => ({
      email: u.email,
      role: u.role,
      passwordHash: hashPassword(u.pw),
    })),
  );
  const auth = initAuth({ AUTH_JWT_SECRET: 'testsecret', AUTH_USERS } as NodeJS.ProcessEnv);
  const built = await buildApp({
    store: new MemoryStore(),
    auth,
    allowedTargets: allowed,
    logger: false,
    serveStatic: false,
  });
  app = built.app;
  for (const k of ROLE_KEYS) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: creds[k].email, password: creds[k].pw },
    });
    tokens[k] = r.json().token;
  }
});

const auth = (k: RoleKey) => ({ authorization: `Bearer ${tokens[k]}` });

describe('RBAC matrix', () => {
  it('all roles authenticate', () => {
    expect(tokens.engineer && tokens.ciso && tokens.admin && tokens.viewer).toBeTruthy();
  });

  it('read (GET /api/campaigns): all roles allowed', async () => {
    for (const k of ROLE_KEYS) {
      const r = await app.inject({ method: 'GET', url: '/api/campaigns', headers: auth(k) });
      expect(r.statusCode).toBe(200);
    }
  });

  it('create (POST /api/campaigns): engineer only', async () => {
    const expected: Record<RoleKey, number> = { engineer: 201, ciso: 403, admin: 403, viewer: 403 };
    for (const k of ROLE_KEYS) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: auth(k),
        payload: campaignBody,
      });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('approve: CISO reaches handler (404), others 403', async () => {
    const expected: Record<RoleKey, number> = { engineer: 403, ciso: 404, admin: 403, viewer: 403 };
    for (const k of ROLE_KEYS) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/campaigns/nope/approval',
        headers: auth(k),
        payload: { decision: 'APPROVED' },
      });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('execute: engineer reaches handler (404), others 403', async () => {
    const expected: Record<RoleKey, number> = { engineer: 404, ciso: 403, admin: 403, viewer: 403 };
    for (const k of ROLE_KEYS) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/campaigns/nope/execute',
        headers: auth(k),
      });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('kill: engineer/ciso/admin allowed (404), viewer 403', async () => {
    const expected: Record<RoleKey, number> = { engineer: 404, ciso: 404, admin: 404, viewer: 403 };
    for (const k of ROLE_KEYS) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/campaigns/nope/kill',
        headers: auth(k),
      });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('user management (GET /api/users): admin only', async () => {
    const expected: Record<RoleKey, number> = { engineer: 403, ciso: 403, admin: 200, viewer: 403 };
    for (const k of ROLE_KEYS) {
      const r = await app.inject({ method: 'GET', url: '/api/users', headers: auth(k) });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('no token → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(r.statusCode).toBe(401);
  });
});
