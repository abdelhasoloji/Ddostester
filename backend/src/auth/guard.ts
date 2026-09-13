import type { FastifyRequest } from 'fastify';
import { verifyJwt, signJwt } from './jwt.js';
import type { JwtPayload } from './jwt.js';
import { verifyPassword } from './passwords.js';
import { loadUsers } from './users.js';
import type { User } from './users.js';
import { canonicalRole } from './rbac.js';
import type { Role } from './rbac.js';

export interface AuthState {
  enabled: boolean;
  secret: string;
  users: Map<string, User>;
}

/** Auth enabled only if AUTH_JWT_SECRET is set (otherwise dev mode). */
export function initAuth(env = process.env): AuthState {
  const secret = env.AUTH_JWT_SECRET ?? '';
  const users = loadUsers(env.AUTH_USERS);
  return { enabled: secret !== '', secret, users };
}

export interface Identity {
  email: string;
  role: Role;
}

export function login(
  state: AuthState,
  email: string,
  password: string,
): { token: string; email: string; role: Role } | null {
  const u = state.users.get(email.toLowerCase());
  if (!u || !verifyPassword(password, u.passwordHash)) return null;
  const token = signJwt({ sub: u.email, role: u.role }, state.secret);
  return { token, email: u.email, role: u.role };
}

/** Verified JWT payload from the Bearer header, or null. */
export function payloadFromRequest(state: AuthState, req: FastifyRequest): JwtPayload | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyJwt(header.slice(7), state.secret);
}

export function identityFromRequest(state: AuthState, req: FastifyRequest): Identity | null {
  const payload = payloadFromRequest(state, req);
  if (!payload) return null;
  // Canonicalise the legacy `officer` id (from a pre-overhaul token) to `admin`.
  const role = canonicalRole(payload.role);
  if (!role) return null;
  return { email: payload.sub, role };
}
