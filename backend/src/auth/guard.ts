import type { FastifyRequest } from 'fastify';
import { verifyJwt, signJwt } from './jwt.js';
import { verifyPassword } from './passwords.js';
import { loadUsers } from './users.js';
import type { User } from './users.js';
import type { Role } from './rbac.js';

export interface AuthState {
  enabled: boolean;
  secret: string;
  users: Map<string, User>;
}

/** Auth activée uniquement si AUTH_JWT_SECRET est défini (sinon mode dev). */
export function initAuth(env = process.env): AuthState {
  const secret = env.AUTH_JWT_SECRET ?? '';
  const users = loadUsers(env.AUTH_USERS);
  return { enabled: secret !== '', secret, users };
}

export interface Identity {
  email: string;
  role: Role;
}

export function login(state: AuthState, email: string, password: string): { token: string; email: string; role: Role } | null {
  const u = state.users.get(email.toLowerCase());
  if (!u || !verifyPassword(password, u.passwordHash)) return null;
  const token = signJwt({ sub: u.email, role: u.role }, state.secret);
  return { token, email: u.email, role: u.role };
}

export function identityFromRequest(state: AuthState, req: FastifyRequest): Identity | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyJwt(header.slice(7), state.secret);
  if (!payload) return null;
  return { email: payload.sub, role: payload.role as Role };
}
