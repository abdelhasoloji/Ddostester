import { registerClientWorkspaceRoutes } from './client-workspace-routes.js';
import { registerInfrastructureRoutes } from './infrastructure-routes.js';
import { drsWorkflow } from '../modules/drs/catalog.js';
import { FLEET_INVENTORY_LIMITS } from '../config/limits.js';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Permission } from '../auth/rbac.js';
import type { Store } from '../store/index.js';
import { randomUUID } from 'node:crypto';
import { deviceInput, DeviceInputError, fleetDeviceView } from '../modules/fleet/devices.js';
import { registerFleetEnrollmentRoutes } from './fleet-enrollment-routes.js';
import { mutationActor } from '../store/audited.js';

export function registerFleetRoutes(
  app: FastifyInstance,
  store: Store,
  guard: (permission: Permission) => preHandlerHookHandler,
) {
  registerFleetEnrollmentRoutes(app, store, guard);
  registerInfrastructureRoutes(app, store, guard);
  registerClientWorkspaceRoutes(app, store, guard);
  const siteOf = (d: { siteId?: string }) => d.siteId ?? 'vps-lab';
  app.get('/api/fleet/sites', { preHandler: guard('campaign:read') }, async () => {
    const devices = await store.listFleetDevices();
    const sites = new Map<string, { id: string; devices: number; online: number }>();
    for (const d of devices) {
      const id = siteOf(d);
      const site = sites.get(id) ?? { id, devices: 0, online: 0 };
      site.devices++;
      if (fleetDeviceView(d).connection === 'online') site.online++;
      sites.set(id, site);
    }
    return {
      sites: [...sites.values()].sort((a, b) => a.id.localeCompare(b.id)),
      devices: devices.length,
      limits: FLEET_INVENTORY_LIMITS,
      scope: 'Inventory capacity; simultaneous execution uses the separate Fleet envelope.',
    };
  });
  app.get('/api/fleet/devices', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const q = req.query as { page?: string; pageSize?: string; siteId?: string; search?: string };
    const integer = (value: string | undefined, fallback: number) =>
      value === undefined ? fallback : /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : NaN;
    const paged = drsWorkflow() || Object.keys(q).length > 0;
    const page = integer(q.page, 1),
      pageSize = integer(q.pageSize, FLEET_INVENTORY_LIMITS.pageSize);
    if (
      !Number.isSafeInteger(page) ||
      !Number.isSafeInteger(pageSize) ||
      pageSize > FLEET_INVENTORY_LIMITS.pageSize ||
      (q.siteId && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(q.siteId)) ||
      (q.search?.length ?? 0) > 128
    )
      return reply.code(400).send({ error: 'Invalid inventory pagination or site' });
    const devices = (await store.listFleetDevices())
      .filter(
        (d) =>
          (!q.siteId || siteOf(d) === q.siteId) &&
          (!q.search ||
            [d.name, d.agentId, d.group, d.privateIp, siteOf(d)].some((v) =>
              v.toLowerCase().includes(q.search!.toLowerCase()),
            )),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      devices: (paged ? devices.slice((page - 1) * pageSize, page * pageSize) : devices).map((d) =>
        fleetDeviceView(d),
      ),
      total: devices.length,
      page,
      pageSize,
    };
  });
  app.get<{ Params: { id: string } }>(
    '/api/fleet/devices/:id',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const device = await store.getFleetDevice(req.params.id);
      if (!device) return reply.code(404).send({ error: 'Fleet device not found' });
      return fleetDeviceView(device);
    },
  );
  const save = async (body: unknown, id?: string) => {
    const input = deviceInput.parse(body);
    return store.transaction(async (tx) => {
      const devices = await tx.listFleetDevices();
      const current = id ? devices.find((d) => d.id === id) : undefined;
      if (id && !current) throw new Error('not_found');
      if (!id && devices.length >= FLEET_INVENTORY_LIMITS.maxDevices)
        throw new Error('inventory_full');
      if (
        new Set([...devices.filter((d) => d.id !== id).map(siteOf), siteOf(input)]).size >
        FLEET_INVENTORY_LIMITS.maxSites
      )
        throw new Error('site_limit_reached');
      if (
        devices.some(
          (d) =>
            d.id !== id &&
            (d.agentId === input.agentId ||
              (d.privateIp === input.privateIp && siteOf(d) === siteOf(input))),
        )
      )
        throw new Error('duplicate_identity');
      const at = new Date().toISOString();
      const device = {
        ...current,
        ...input,
        id: id ?? randomUUID(),
        createdAt: current?.createdAt ?? at,
        updatedAt: at,
      };
      if (
        current &&
        (current.agentId !== input.agentId ||
          current.privateIp !== input.privateIp ||
          siteOf(current) !== siteOf(input))
      ) {
        delete device.credential;
        delete device.heartbeat;
        device.enrollmentRevoked = true;
      }
      await tx.saveFleetDevice(device);
      await tx.saveAudit({
        id: randomUUID(),
        at,
        actor: mutationActor.getStore() ?? 'system',
        action: 'store.mutate',
        detail: `fleet.device.${id ? 'update' : 'create'} id=${device.id}`,
      });
      return fleetDeviceView(device);
    });
  };
  const failure = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    return message === 'not_found'
      ? 404
      : ['duplicate_identity', 'inventory_full', 'site_limit_reached'].includes(message)
        ? 409
        : 400;
  };
  app.post('/api/fleet/devices', { preHandler: guard('user:manage') }, async (req, reply) => {
    try {
      return reply.code(201).send(await save(req.body));
    } catch (error) {
      if (
        error instanceof Error &&
        (error instanceof DeviceInputError ||
          ['not_found', 'duplicate_identity', 'inventory_full', 'site_limit_reached'].includes(
            error.message,
          ))
      )
        return reply.code(failure(error)).send({ error: error.message });
      throw error;
    }
  });
  app.put<{ Params: { id: string } }>(
    '/api/fleet/devices/:id',
    { preHandler: guard('user:manage') },
    async (req, reply) => {
      try {
        return await save(req.body, req.params.id);
      } catch (error) {
        if (
          error instanceof Error &&
          (error instanceof DeviceInputError ||
            ['not_found', 'duplicate_identity', 'inventory_full', 'site_limit_reached'].includes(
              error.message,
            ))
        )
          return reply.code(failure(error)).send({ error: error.message });
        throw error;
      }
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/fleet/devices/:id',
    { preHandler: guard('user:manage') },
    async (req, reply) => {
      const removed = await store.transaction(async (tx) => {
        if (!(await tx.listFleetDevices()).some((d) => d.id === req.params.id)) return false;
        await tx.deleteFleetDevice(req.params.id);
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor: mutationActor.getStore() ?? 'system',
          action: 'store.mutate',
          detail: `fleet.device.remove id=${req.params.id}`,
        });
        return true;
      });
      return reply.code(removed ? 204 : 404).send();
    },
  );
}
