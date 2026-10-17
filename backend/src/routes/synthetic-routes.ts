import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Store } from '../store/types.js';
import type { Permission } from '../auth/rbac.js';
import { SyntheticCoordinator } from '../modules/bench/journey.js';
import { SYNTHETIC_JOURNEY_LIMITS } from '../config/limits.js';
import { DrsError } from '../modules/drs/model.js';

export async function registerSyntheticRoutes(
  app: FastifyInstance,
  store: Store,
  guard: (p: Permission) => preHandlerHookHandler,
  options: {
    enabled: () => boolean;
    targets: readonly string[];
    requireApproval: boolean;
    requireCiso: boolean;
  },
) {
  const coordinator = new SyntheticCoordinator(store, options.enabled, options.targets);
  await coordinator.reconcile();
  const timer = setInterval(
    () =>
      void coordinator
        .tick()
        .catch((err) => app.log.error({ err }, 'Synthetic coordination failed')),
    SYNTHETIC_JOURNEY_LIMITS.tickMs,
  );
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await coordinator.close();
  });
  app.get(
    '/api/synthetic-campaigns/:id',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      const c = await store.getCampaign((req.params as { id: string }).id);
      if (!c?.syntheticJourney)
        return reply.code(404).send({ error: 'Synthetic campaign not found' });
      const runs = await Promise.all(
        c.syntheticJourney.steps.map((s) =>
          s.runId ? store.getBenchRun(s.runId) : Promise.resolve(null),
        ),
      );
      return { campaign: c, runs };
    },
  );
  app.post(
    '/api/synthetic-campaigns',
    { preHandler: [guard('campaign:create'), guard('bench:dispatch')] },
    async (req, reply) => {
      try {
        const c = await coordinator.create(
          (req.body ?? {}) as Parameters<SyntheticCoordinator['create']>[0],
          req.authUser?.email ?? 'dev',
        );
        return reply.code(201).send(c);
      } catch (e) {
        if (e instanceof DrsError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    },
  );
  for (const action of ['start', 'pause', 'resume', 'stop'] as const)
    app.post(
      '/api/synthetic-campaigns/:id/' + action,
      {
        preHandler:
          action === 'stop'
            ? [guard('campaign:kill')]
            : action === 'start'
              ? [guard('campaign:execute'), guard('campaign:approve'), guard('bench:dispatch')]
              : [guard('bench:dispatch')],
      },
      async (req, reply) => {
        try {
          return await coordinator.control(
            (req.params as { id: string }).id,
            action,
            req.authUser?.email ?? 'dev',
            {
              ...((req.body as { confirmed?: boolean; planHash?: string }) ?? {}),
              requireApproval: options.requireApproval,
              requireCiso: options.requireCiso,
            },
          );
        } catch (e) {
          if (e instanceof DrsError) return reply.code(409).send({ error: e.message });
          throw e;
        }
      },
    );
  return coordinator;
}
