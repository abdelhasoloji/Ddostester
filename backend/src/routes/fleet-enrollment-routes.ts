import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Permission } from '../auth/rbac.js';
import type { Store } from '../store/index.js';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fleetDeviceView } from '../modules/fleet/devices.js';
import { mutationActor } from '../store/audited.js';
import { readFile } from 'node:fs/promises';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function registerFleetEnrollmentRoutes(
  app: FastifyInstance,
  store: Store,
  guard: (permission: Permission) => preHandlerHookHandler,
) {
  app.get(
    '/api/fleet/agent-client.mjs',
    { preHandler: guard('campaign:read') },
    async (_req, reply) => {
      return reply
        .type('text/plain; charset=utf-8')
        .header('content-disposition', 'attachment; filename="heartbeat-agent.mjs"')
        .header('cache-control', 'no-store')
        .send(
          await readFile(
            new URL('../../../scripts/fleet/heartbeat-agent.mjs', import.meta.url),
            'utf8',
          ),
        );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/fleet/devices/:id/enrollment',
    { preHandler: guard('user:manage') },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const result = await store.transaction(async (tx) => {
        const device = await tx.getFleetDevice(req.params.id);
        if (!device) return null;
        const token = randomBytes(32).toString('hex');
        device.credential = { hash: digest(token), expiresAt: Date.now() + 7 * 86400_000 };
        delete device.heartbeat;
        device.enrollmentRevoked = false;
        await tx.saveFleetDevice(device);
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor: mutationActor.getStore() ?? 'system',
          action: 'store.mutate',
          detail: `fleet.device.enroll id=${device.id}`,
        });
        return {
          schema: 'ddostester.fleet.enrollment/v1',
          deviceId: device.id,
          agentId: device.agentId,
          privateIp: device.privateIp,
          token,
          expiresAt: new Date(device.credential.expiresAt).toISOString(),
        };
      });
      return result ?? reply.code(404).send({ error: 'not_found' });
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/fleet/devices/:id/enrollment',
    { preHandler: guard('user:manage') },
    async (req, reply) => {
      const result = await store.transaction(async (tx) => {
        const device = await tx.getFleetDevice(req.params.id);
        if (!device) return null;
        delete device.credential;
        device.enrollmentRevoked = true;
        await tx.saveFleetDevice(device);
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor: mutationActor.getStore() ?? 'system',
          action: 'store.mutate',
          detail: `fleet.device.revoke id=${device.id}`,
        });
        return fleetDeviceView(device);
      });
      return result ?? reply.code(404).send({ error: 'not_found' });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/fleet/devices/:id/heartbeat',
    { bodyLimit: 4096 },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (!token || !/^[a-f0-9]{64}$/.test(token))
        return reply.code(401).send({ error: 'invalid_agent_credential' });
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (k) => !['agentId', 'privateIp', 'sequence', 'version', 'uptimeSec'].includes(k),
        ) ||
        typeof body.agentId !== 'string' ||
        typeof body.privateIp !== 'string' ||
        !Number.isSafeInteger(body.sequence) ||
        Number(body.sequence) < 1 ||
        typeof body.version !== 'string' ||
        !['inventory-heartbeat/v1', 'fleet-mission-agent/v1', 'fleet-mission-agent/v2'].includes(
          body.version,
        ) ||
        !Number.isFinite(body.uptimeSec) ||
        Number(body.uptimeSec) < 0 ||
        Number(body.uptimeSec) > 1e9
      )
        return reply.code(400).send({ error: 'invalid_heartbeat' });
      const result = await store.transaction(async (tx) => {
        const device = await tx.getFleetDevice(req.params.id);
        const now = Date.now();
        if (
          !device?.credential ||
          device.credential.expiresAt <= now ||
          !timingSafeEqual(
            Buffer.from(device.credential.hash, 'hex'),
            Buffer.from(digest(token), 'hex'),
          )
        )
          return { code: 401, error: 'invalid_agent_credential' };
        if (body.agentId !== device.agentId || body.privateIp !== device.privateIp)
          return { code: 403, error: 'agent_identity_mismatch' };
        if (Number(body.sequence) <= (device.heartbeat?.sequence ?? 0))
          return { code: 409, error: 'stale_sequence' };
        if (device.heartbeat && now - device.heartbeat.receivedAt < 2000)
          return { code: 429, error: 'heartbeat_too_frequent' };
        device.heartbeat = {
          sequence: Number(body.sequence),
          receivedAt: now,
          version: String(body.version),
          uptimeSec: Number(body.uptimeSec),
          peerIp: req.ip,
        };
        await tx.saveFleetDevice(device);
        return { code: 200, error: undefined };
      });
      return reply
        .code(result.code)
        .send(
          result.error ? { error: result.error } : { accepted: true, heartbeatIntervalMs: 5000 },
        );
    },
  );
}
