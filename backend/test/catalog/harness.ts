import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { MemoryStore } from '../../src/store/memory.js';
import { initAuth } from '../../src/auth/guard.js';
import { hashPassword } from '../../src/auth/passwords.js';

// Shared harness for the data-driven functional catalog. Every case runs against
// a real Fastify instance via app.inject — fast, in-process, no browser.

export const ALLOWED = ['127.0.0.1', 'localhost'];

export const CREDS = {
  officer: { email: 'off@wedos', role: 'officer', pw: 'pw-officer-123' },
  engineer: { email: 'eng@wedos', role: 'engineer', pw: 'pw-engineer-123' },
  viewer: { email: 'view@wedos', role: 'viewer', pw: 'pw-viewer-123' },
} as const;
export type RoleKey = keyof typeof CREDS;
export const ROLE_KEYS = Object.keys(CREDS) as RoleKey[];

export interface AuthedApp {
  app: FastifyInstance;
  tokens: Record<RoleKey, string>;
}

/** App with auth + RBAC enabled and one seeded user per role. */
export async function buildAuthedApp(): Promise<AuthedApp> {
  const AUTH_USERS = JSON.stringify(
    Object.values(CREDS).map((u) => ({
      email: u.email,
      role: u.role,
      passwordHash: hashPassword(u.pw),
    })),
  );
  const auth = initAuth({ AUTH_JWT_SECRET: 'catalog-secret', AUTH_USERS } as NodeJS.ProcessEnv);
  const built = await buildApp({
    store: new MemoryStore(),
    auth,
    allowedTargets: ALLOWED,
    logger: false,
    serveStatic: false,
  });
  const tokens = {} as Record<RoleKey, string>;
  for (const k of ROLE_KEYS) {
    const r = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: CREDS[k].email, password: CREDS[k].pw },
    });
    tokens[k] = r.json().token as string;
  }
  return { app: built.app, tokens };
}

/** App with auth disabled (dev mode): every action is open. */
export async function buildOpenApp(): Promise<FastifyInstance> {
  const auth = initAuth({} as NodeJS.ProcessEnv);
  const built = await buildApp({
    store: new MemoryStore(),
    auth,
    allowedTargets: ALLOWED,
    logger: false,
    serveStatic: false,
  });
  return built.app;
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** A valid, in-caps campaign body; override fields per case. */
export function campaign(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'catalog',
    target: 'http://127.0.0.1/',
    probeUrl: 'http://127.0.0.1/',
    vector: 'http-get',
    maxRps: 10,
    concurrency: 2,
    maxDurationSec: 5,
    authorized: true,
    createdBy: 'eng@wedos',
    ...over,
  };
}

// ---- results collector + report writer ------------------------------------

export type Outcome = 'CONFORMS' | 'FINDING';
export interface CaseResult {
  id: string;
  area: string;
  title: string;
  spec: string;
  want: string;
  got: string;
  pass: boolean;
  outcome: Outcome;
  note?: string;
}

export const results: CaseResult[] = [];

export function record(r: CaseResult): void {
  results.push(r);
}
