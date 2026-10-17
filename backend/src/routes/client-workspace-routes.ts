import { randomUUID } from 'node:crypto';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Permission } from '../auth/rbac.js';
import type { Store } from '../store/index.js';
import { mutationActor } from '../store/audited.js';
import {
  initialClients,
  clientProfile,
  type ClientProfile,
} from '../modules/infrastructure/clients.js';
import { InfrastructureError, identifier, makeRevision } from '../modules/infrastructure/model.js';
import { INFRASTRUCTURE_LIMITS } from '../config/limits.js';
export function registerClientWorkspaceRoutes(
  app: FastifyInstance,
  store: Store,
  guard: (p: Permission) => preHandlerHookHandler,
) {
  const base = '/api/workspace/clients';
  app.get(base, { preHandler: guard('campaign:read') }, async () => {
    const saved = await store.listInfrastructure('client');
    const ids = initialClients.map((c) => c.id);
    return {
      targetLevel: 5,
      pilot: { sites: 2, independentProbe: 1, capacityQualified: false },
      clients: ids.map((id) => {
        const record = saved.find((r) => r.id === id);
        return {
          id,
          revision: record?.revision ?? 0,
          hash: record?.hash ?? null,
          profile: (record?.payload ??
            initialClients.find((c) => c.id === id)!.profile) as ClientProfile,
          status: 'authorized',
          authorization: 'client-authorized-target-scope-separate',
          measuredScore: null,
        };
      }),
    };
  });
  app.put<{ Params: { id: string } }>(
    base + '/:id',
    { preHandler: guard('user:manage') },
    async (req, reply) => {
      try {
        const id = identifier(req.params.id),
          body = req.body as { expectedRevision?: unknown; profile?: unknown };
        if (
          !body ||
          Object.keys(body).some((k) => !['expectedRevision', 'profile'].includes(k)) ||
          !Number.isSafeInteger(body.expectedRevision) ||
          Number(body.expectedRevision) < 0
        )
          throw new InfrastructureError('Expected revision required');
        const fixedClient = initialClients.find((c) => c.id === id);
        if (!fixedClient)
          throw new InfrastructureError(
            'Only the three authorized client records are available',
            404,
          );
        const profile = clientProfile(body.profile);
        if (profile.name !== fixedClient.profile.name)
          throw new InfrastructureError('Client identity is fixed');
        return await store.transaction(async (tx) => {
          const clients = await tx.listInfrastructure('client'),
            previous = clients.find((r) => r.id === id);
          if ((previous?.revision ?? 0) !== body.expectedRevision)
            throw new InfrastructureError('Client changed; reload before saving', 409);
          const count = new Set([
            ...initialClients.map((c) => c.id),
            ...clients.map((r) => r.id),
            id,
          ]).size;
          if (
            count > INFRASTRUCTURE_LIMITS.maxClients ||
            (previous?.revision ?? 0) >= INFRASTRUCTURE_LIMITS.maxRevisions
          )
            throw new InfrastructureError('Client storage limit reached', 409);
          const record = makeRevision(
            'client',
            id,
            profile,
            previous,
            mutationActor.getStore() ?? 'system',
          );
          await tx.appendInfrastructure(record);
          await tx.saveAudit({
            id: randomUUID(),
            at: record.at,
            actor: record.actor,
            action: 'store.mutate',
            detail: `workspace.client id=${id} revision=${record.revision} sha256=${record.hash}`,
          });
          return {
            id,
            revision: record.revision,
            hash: record.hash,
            profile,
            status: 'authorized',
            authorization: 'client-authorized-target-scope-separate',
            measuredScore: null,
          };
        });
      } catch (error) {
        if (error instanceof InfrastructureError)
          return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    base + '/:id/history',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      try {
        const id = identifier(req.params.id);
        if (!initialClients.some((c) => c.id === id))
          throw new InfrastructureError('Unknown authorized client', 404);
        return {
          revisions: await store.infrastructureHistory('client', id),
        };
      } catch (error) {
        if (error instanceof InfrastructureError)
          return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    },
  );
}
