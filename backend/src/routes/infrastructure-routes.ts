import { randomUUID } from 'node:crypto';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Permission } from '../auth/rbac.js';
import type { Store } from '../store/index.js';
import { mutationActor } from '../store/audited.js';
import { INFRASTRUCTURE_LIMITS } from '../config/limits.js';
import { drsCatalog } from '../modules/drs/catalog.js';
import { drsReference } from '../modules/drs/reference.js';
import {
  identifier,
  hostProfile,
  infrastructureEvidence,
  makeRevision,
  qualification,
  InfrastructureError,
  type InfrastructureRevision,
} from '../modules/infrastructure/model.js';

/** Inventory and evidence only: never imports a coordinator, generator or Kubernetes client. */
export function registerInfrastructureRoutes(
  app: FastifyInstance,
  store: Store,
  guard: (permission: Permission) => preHandlerHookHandler,
) {
  const base = '/api/fleet/infrastructure';
  const handle = async (
    operation: () => Promise<unknown>,
    reply: import('fastify').FastifyReply,
  ) => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof InfrastructureError)
        return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  };
  app.get(base, { preHandler: guard('campaign:read') }, async (req, reply) =>
    handle(async () => {
      const query = req.query as { hosts?: string };
      if (query.hosts !== undefined && typeof query.hosts !== 'string')
        throw new InfrastructureError('Invalid host selection');
      const selected = query.hosts ? query.hosts.split(',').map(identifier) : [];
      if (selected.length > 2 || new Set(selected).size !== selected.length)
        throw new InfrastructureError('Select at most two distinct physical hosts');
      const hosts = await store.listInfrastructure('host'),
        evidence = await store.listInfrastructure('evidence');
      const catalog = drsCatalog(),
        { vectors } = drsReference();
      return {
        hosts,
        evidence,
        qualification: qualification(hosts, evidence, selected),
        limits: INFRASTRUCTURE_LIMITS,
        readiness: {
          standardVersion: catalog.version,
          catalogueHash: catalog.catalogueHash,
          targetLevel: 5,
          scope: 'Product capability inventory, not campaign verdicts or measured capacity',
          fullPhysicalVectorsQualified: 0,
          levels: [1, 2, 3, 4, 5].map((level) => ({
            level,
            total: catalog.profiles.filter((p) => p.level === level).length,
            boundedHttp: catalog.profiles.filter((p) => p.level === level && p.supported).length,
            physicalQualified: 0,
          })),
          vectors: catalog.profiles
            .filter((p) => p.level <= 5)
            .map((p) => {
              const source = vectors.find((v) => v.internal_id === p.id)!;
              return {
                id: p.id,
                name: p.name,
                level: p.level,
                family: source.family,
                sourceVectorId: p.sourceVectorId,
                sourcePage: p.sourcePage,
                adapter: p.supported ? 'bounded-http-only' : 'reference-only',
                fullPhysicalStatus: 'not-qualified',
                ambiguityCount: p.ambiguityCount,
              };
            }),
        },
      };
    }, reply),
  );
  app.get<{ Params: { kind: string; id: string } }>(
    base + '/:kind/:id/history',
    { preHandler: guard('campaign:read') },
    async (req, reply) =>
      handle(async () => {
        const { kind, id } = req.params;
        if (kind !== 'host' && kind !== 'evidence')
          throw new InfrastructureError('Invalid record kind');
        return { revisions: await store.infrastructureHistory(kind, identifier(id)) };
      }, reply),
  );
  app.put<{ Params: { id: string } }>(
    base + '/hosts/:id',
    { preHandler: guard('user:manage') },
    async (req, reply) =>
      handle(async () => {
        const id = identifier(req.params.id);
        const body = req.body as { expectedRevision?: unknown; profile?: unknown };
        if (
          !body ||
          Object.keys(body).some((k) => !['expectedRevision', 'profile'].includes(k)) ||
          !Number.isSafeInteger(body.expectedRevision) ||
          Number(body.expectedRevision) < 0
        )
          throw new InfrastructureError('Expected revision required');
        const profile = hostProfile(body.profile);
        return store.transaction(async (tx) => {
          const hosts = await tx.listInfrastructure('host');
          const previous = hosts.find((h) => h.id === id);
          if ((previous?.revision ?? 0) !== body.expectedRevision)
            throw new InfrastructureError('Profile changed; reload before saving', 409);
          if (
            (!previous && hosts.length >= INFRASTRUCTURE_LIMITS.maxHosts) ||
            (previous?.revision ?? 0) >= INFRASTRUCTURE_LIMITS.maxRevisions
          )
            throw new InfrastructureError('Infrastructure storage limit reached', 409);
          const record = makeRevision(
            'host',
            id,
            profile,
            previous,
            mutationActor.getStore() ?? 'system',
          );
          await append(tx, record);
          return record;
        });
      }, reply),
  );
  app.post(base + '/evidence', { preHandler: guard('user:manage') }, async (req, reply) =>
    handle(async () => {
      const evidence = infrastructureEvidence(req.body);
      const saved = await store.transaction(async (tx) => {
        const host = (await tx.listInfrastructure('host')).find((h) => h.id === evidence.hostId);
        if (!host || host.hash !== evidence.profileHash)
          throw new InfrastructureError('Evidence must bind the current host profile', 409);
        if ((await tx.listInfrastructure('evidence')).length >= INFRASTRUCTURE_LIMITS.maxEvidence)
          throw new InfrastructureError('Evidence storage limit reached', 409);
        // Every submission is retained independently, including failed observations.
        const record = makeRevision(
          'evidence',
          randomUUID(),
          evidence,
          undefined,
          mutationActor.getStore() ?? 'system',
        );
        await append(tx, record);
        return record;
      });
      return reply.code(201).send(saved);
    }, reply),
  );
}
async function append(store: Store, record: InfrastructureRevision) {
  await store.appendInfrastructure(record);
  await store.saveAudit({
    id: randomUUID(),
    at: record.at,
    actor: record.actor,
    action: 'store.mutate',
    detail: `infrastructure.${record.kind} id=${record.id} revision=${record.revision} sha256=${record.hash}`,
  });
}
