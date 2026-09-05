import 'fastify';
import type { Role } from './rbac.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: { email: string; role: Role };
  }
}
