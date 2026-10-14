import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { Store, UserTransaction } from '../store/types.js';
import type { AuthState } from '../auth/guard.js';
import type { Permission } from '../auth/rbac.js';
import type { AuditEntry } from '../modules/audit/model.js';
import { hashPasswordAsync } from '../auth/passwords.js';
import {
  assertUpsert,
  assertRoleChange,
  assertStatusChange,
  assertReset,
  assertDelete,
  combineUsers,
  UserError,
} from '../modules/users/service.js';
export function registerUserRoutes(
  app: FastifyInstance,
  ctx: { store: Store; auth: AuthState; guard: (p: Permission) => preHandlerHookHandler },
): void {
  const { store, auth, guard } = ctx;
  const current = async (tx: UserTransaction) =>
    combineUsers([...auth.users.values()], await tx.listUsers());
  const guardContext = async (tx: UserTransaction, req: FastifyRequest) => ({
    envEmails: new Set(auth.users.keys()),
    current: await current(tx),
    actorEmail: req.authUser?.email ?? '',
    primaryAdminEmail: (await tx.getAccountPolicy())?.primaryAdminEmail,
  });
  const audit = (
    tx: UserTransaction,
    req: FastifyRequest,
    action: AuditEntry['action'],
    detail: string,
  ) =>
    tx.saveAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: req.authUser?.email ?? 'dev',
      action,
      detail,
    });
  const perform = async (
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (tx: UserTransaction) => Promise<unknown>,
  ) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    try {
      return await store.transactionUsers(fn);
    } catch (err) {
      if (err instanceof UserError)
        return reply
          .code(err.message.startsWith('User already exists') ? 409 : 400)
          .send({ error: err.message });
      req.log.error(err);
      return reply.code(500).send({ error: 'account update failed' });
    }
  };
  app.get('/api/users', { preHandler: guard('user:manage') }, async (_req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    const owner = (await store.getAccountPolicy())?.primaryAdminEmail;
    return (await current(store)).map((u) => ({ ...u, isOwner: u.email === owner }));
  });
  app.post('/api/users', { preHandler: guard('user:manage') }, async (req, reply) =>
    perform(req, reply, async (tx) => {
      const body = (req.body ?? {}) as { email?: string; role?: string; password?: string };
      const context = await guardContext(tx, req);
      const { email, role } = assertUpsert(
        { email: body.email ?? '', role: body.role ?? '', password: body.password ?? '' },
        context,
      );
      if (context.current.some((u) => u.email === email))
        throw new UserError('User already exists — use PATCH to change their role.');
      await tx.saveUser({
        email,
        role,
        passwordHash: await hashPasswordAsync(body.password!),
        status: 'active',
        mustChangePassword: true,
        createdAt: new Date().toISOString(),
        tokenVersion: 0,
      });
      await audit(tx, req, 'user.upsert', `${email} -> ${role} (create)`);
      reply.code(201);
      return { email, role, source: 'store', mustChangePassword: true };
    }),
  );
  app.patch('/api/users/:email', { preHandler: guard('user:manage') }, async (req, reply) =>
    perform(req, reply, async (tx) => {
      const email = (req.params as { email: string }).email.trim().toLowerCase();
      const body = (req.body ?? {}) as { role?: string; status?: string };
      if (body.role == null && body.status == null)
        throw new UserError('nothing to change (role or status required)');
      const context = await guardContext(tx, req);
      const role = body.role != null ? assertRoleChange(email, body.role, context).role : undefined;
      const status =
        body.status != null ? assertStatusChange(email, body.status, context).status : undefined;
      const existing = await tx.getUser(email);
      if (!existing) throw new UserError('User not found.');
      const changed =
        (role !== undefined && role !== existing.role) ||
        (status !== undefined && status !== (existing.status ?? 'active'));
      const next = {
        ...existing,
        ...(role ? { role } : {}),
        ...(status ? { status } : {}),
        tokenVersion: (existing.tokenVersion ?? 0) + (changed ? 1 : 0),
      };
      await tx.saveUser(next);
      if (role !== undefined && role !== existing.role)
        await audit(tx, req, 'user.upsert', `${email} -> ${role} (role change)`);
      if (status !== undefined && status !== (existing.status ?? 'active'))
        await audit(tx, req, 'user.status', `${email} -> ${status}`);
      return { email, role: next.role, status: next.status, source: 'store' };
    }),
  );
  app.post('/api/users/:email/password', { preHandler: guard('user:manage') }, async (req, reply) =>
    perform(req, reply, async (tx) => {
      const raw = (req.params as { email: string }).email;
      const body = (req.body ?? {}) as { password?: string };
      const { email } = assertReset(raw, body.password ?? '', await guardContext(tx, req));
      const existing = await tx.getUser(email);
      if (!existing) throw new UserError('User not found.');
      await tx.saveUser({
        ...existing,
        passwordHash: await hashPasswordAsync(body.password!),
        mustChangePassword: true,
        tokenVersion: (existing.tokenVersion ?? 0) + 1,
      });
      await audit(tx, req, 'password.reset', email);
      return { email, source: 'store', mustChangePassword: true };
    }),
  );
  app.post(
    '/api/users/:email/sessions/revoke',
    { preHandler: guard('user:manage') },
    async (req, reply) =>
      perform(req, reply, async (tx) => {
        const email = (req.params as { email: string }).email.trim().toLowerCase();
        const context = await guardContext(tx, req);
        if (email === context.actorEmail)
          throw new UserError('Use My account to revoke your own sessions.');
        if (context.envEmails.has(email))
          throw new UserError('Import this env account before revoking its sessions.');
        const existing = await tx.getUser(email);
        if (!existing) throw new UserError('User not found.');
        await tx.saveUser({ ...existing, tokenVersion: (existing.tokenVersion ?? 0) + 1 });
        await audit(tx, req, 'auth.sessions_revoke', email);
        return { email, revoked: true };
      }),
  );
  app.delete('/api/users/:email', { preHandler: guard('user:manage') }, async (req, reply) =>
    perform(req, reply, async (tx) => {
      const email = assertDelete(
        (req.params as { email: string }).email,
        await guardContext(tx, req),
      );
      await tx.deleteUser(email);
      await audit(tx, req, 'user.delete', email);
      return { deleted: email };
    }),
  );
}
