import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Permission } from '../auth/rbac.js';
import type { Store } from '../store/types.js';
import type { AuditEntry } from '../modules/audit/model.js';
import {
  createTarget,
  requestAuthorization,
  authorizeTarget,
  revokeTarget,
  normalizeHost,
  TargetError,
} from '../modules/targets/model.js';

type TargetAudit = Extract<AuditEntry['action'], `target.${string}`>;

export interface TargetRoutesCtx {
  store: Store;
  guard: (perm: Permission) => preHandlerHookHandler;
  /** Audit hook (actor derived from the request inside the app). */
  audit: (req: FastifyRequest, action: TargetAudit, detail?: string) => void | Promise<void>;
  /** The env allowlist base — a host already permanently allowlisted needs no onboarding. */
  envAllowlist: string[];
  actorOf: (req: FastifyRequest) => string;
}

interface CreateBody {
  host?: unknown;
  displayName?: unknown;
  notes?: unknown;
  owner?: unknown;
  attestation?: unknown;
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Protected-target onboarding routes.
 *
 * SAFETY: registering a target is metadata only and grants NO test permission.
 * A host becomes testable only after a CISO (`target:authorize`) — distinct from
 * the requester — authorizes it, which adds it to the effective allowlist. Every
 * transition is audited. HARD_CAPS, approval, attestation and the kill switch
 * are untouched; this only governs WHICH hosts a bounded campaign may target.
 */
export function registerTargetRoutes(app: FastifyInstance, ctx: TargetRoutesCtx): void {
  const { store, guard, audit, envAllowlist, actorOf } = ctx;

  // List all registered targets (any authenticated operator).
  app.get('/api/targets', { preHandler: guard('campaign:read') }, async () => {
    const targets = await store.listTargets();
    return { targets, envAllowlist };
  });

  // Register a protected zone. Optionally request authorization in the same call
  // when an attestation is supplied.
  app.post('/api/targets', { preHandler: guard('target:manage') }, async (req, reply) => {
    const body = (req.body ?? {}) as CreateBody;
    const by = actorOf(req);
    let host: string;
    try {
      host = normalizeHost(str(body.host) ?? '');
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof TargetError ? err.message : 'invalid host' });
    }
    // A host permanently allowlisted via env is already testable — registering a
    // governed duplicate would be confusing.
    if (envAllowlist.includes(host)) {
      return reply.code(409).send({ error: `host "${host}" is already in the env allowlist` });
    }
    const existing = (await store.listTargets()).find((t) => t.host === host);
    if (existing) {
      return reply
        .code(409)
        .send({ error: `host "${host}" is already registered`, id: existing.id });
    }
    try {
      let target = createTarget(
        {
          host,
          displayName: str(body.displayName),
          notes: str(body.notes),
          owner: str(body.owner),
        },
        { id: randomUUID(), by },
      );
      await audit(req, 'target.register', `${host} registered`);
      const attestation = str(body.attestation)?.trim();
      if (attestation) {
        target = requestAuthorization(target, by, attestation);
        await audit(req, 'target.request_auth', `${host}: authorization requested`);
      }
      await store.saveTarget(target);
      return reply.code(201).send(target);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof TargetError ? err.message : 'could not register target' });
    }
  });

  // Request authorization for an existing target.
  app.post(
    '/api/targets/:id/request',
    { preHandler: guard('target:manage') },
    async (req, reply) => {
      const t = await store.getTarget((req.params as { id: string }).id);
      if (!t) return reply.code(404).send({ error: 'target not found' });
      const attestation =
        str((req.body as { attestation?: unknown } | undefined)?.attestation) ?? '';
      try {
        const next = requestAuthorization(t, actorOf(req), attestation);
        await store.saveTarget(next);
        await audit(req, 'target.request_auth', `${t.host}: authorization requested`);
        return next;
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof TargetError ? err.message : 'could not request authorization',
        });
      }
    },
  );

  // Grant authorization — adds the host to the effective allowlist. CISO; the
  // authorizer must differ from the requester (enforced in the model).
  app.post(
    '/api/targets/:id/authorize',
    { preHandler: guard('target:authorize') },
    async (req, reply) => {
      const t = await store.getTarget((req.params as { id: string }).id);
      if (!t) return reply.code(404).send({ error: 'target not found' });
      try {
        const next = authorizeTarget(t, actorOf(req));
        await store.saveTarget(next);
        await audit(req, 'target.authorize', `${t.host}: authorized (allowlist +1)`);
        return next;
      } catch (err) {
        return reply
          .code(err instanceof TargetError ? 409 : 400)
          .send({ error: err instanceof TargetError ? err.message : 'could not authorize' });
      }
    },
  );

  // Revoke authorization — removes the host from the effective allowlist. CISO.
  app.post(
    '/api/targets/:id/revoke',
    { preHandler: guard('target:authorize') },
    async (req, reply) => {
      const t = await store.getTarget((req.params as { id: string }).id);
      if (!t) return reply.code(404).send({ error: 'target not found' });
      try {
        const next = revokeTarget(t, actorOf(req));
        await store.saveTarget(next);
        await audit(req, 'target.revoke', `${t.host}: authorization revoked (allowlist -1)`);
        return next;
      } catch (err) {
        return reply
          .code(err instanceof TargetError ? 409 : 400)
          .send({ error: err instanceof TargetError ? err.message : 'could not revoke' });
      }
    },
  );

  // Delete a registered target. Only when it is NOT authorized — an authorized
  // host must be revoked first so it always leaves the effective allowlist.
  app.delete('/api/targets/:id', { preHandler: guard('target:manage') }, async (req, reply) => {
    const t = await store.getTarget((req.params as { id: string }).id);
    if (!t) return reply.code(404).send({ error: 'target not found' });
    if (t.authStatus === 'authorized') {
      return reply.code(409).send({ error: 'revoke the target before deleting it' });
    }
    await store.deleteTarget(t.id);
    await audit(req, 'target.delete', `${t.host} removed`);
    return { ok: true };
  });
}
