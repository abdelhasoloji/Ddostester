import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

/**
 * RBAC matrix: every (role × endpoint) resolves to the expected authorization
 * outcome. Non-existent ids are used so the guard (403) is exercised without
 * running real load; an authorized role instead reaches the handler (404).
 */

const allowed = ['127.0.0.1', 'localhost'];
const creds = {
  officer: { email: 'off@wedos', role: 'officer', pw: 'pw-officer-123' },
  engineer: { email: 'eng@wedos', role: 'engineer', pw: 'pw-engineer-123' },
  viewer: { email: 'view@wedos', role: 'viewer', pw: 'pw-viewer-123' },
} as const;
type RoleKey = keyof typeof creds;

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
const tokens: Record<RoleKey, string> = { officer: '', engineer: '', viewer: '' };

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
  for (const k of Object.keys(creds) as RoleKey[]) {
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
    expect(tokens.officer && tokens.engineer && tokens.viewer).toBeTruthy();
  });

  it('read (GET /api/campaigns): all roles allowed', async () => {
    for (const k of Object.keys(creds) as RoleKey[]) {
      const r = await app.inject({ method: 'GET', url: '/api/campaigns', headers: auth(k) });
      expect(r.statusCode).toBe(200);
    }
  });

  it('create (POST /api/campaigns): officer/engineer yes, viewer 403', async () => {
    const expected: Record<RoleKey, number> = { officer: 201, engineer: 201, viewer: 403 };
    for (const k of Object.keys(creds) as RoleKey[]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: auth(k),
        payload: campaignBody,
      });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('approve: officer reaches handler (404), others 403', async () => {
    const expected: Record<RoleKey, number> = { officer: 404, engineer: 403, viewer: 403 };
    for (const k of Object.keys(creds) as RoleKey[]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/campaigns/nope/approval',
        headers: auth(k),
        payload: { decision: 'APPROVED' },
      });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('execute: officer/engineer reach handler (404), viewer 403', async () => {
    const expected: Record<RoleKey, number> = { officer: 404, engineer: 404, viewer: 403 };
    for (const k of Object.keys(creds) as RoleKey[]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/campaigns/nope/execute',
        headers: auth(k),
      });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('kill: all roles allowed (404 with no run in progress)', async () => {
    for (const k of Object.keys(creds) as RoleKey[]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/campaigns/nope/kill',
        headers: auth(k),
      });
      expect(r.statusCode).toBe(404);
    }
  });

  it('user management (GET /api/users): officer only', async () => {
    const expected: Record<RoleKey, number> = { officer: 200, engineer: 403, viewer: 403 };
    for (const k of Object.keys(creds) as RoleKey[]) {
      const r = await app.inject({ method: 'GET', url: '/api/users', headers: auth(k) });
      expect(r.statusCode).toBe(expected[k]);
    }
  });

  it('no token → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(r.statusCode).toBe(401);
  });
});
