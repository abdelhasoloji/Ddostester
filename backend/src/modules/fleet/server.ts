import type { FleetProgress } from './progress.js';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { TLSSocket } from 'node:tls';
import type { FleetCoordinator } from './coordinator.js';
import { agentIdsOf, siteOf, type FleetSite } from './sites.js';
import { FLEET_LIMITS } from '../../config/limits.js';

/** A separate mTLS-only agent surface. It cannot create campaigns or assign budgets. */
export function buildFleetServer(
  coordinator: FleetCoordinator,
  tls: { key: Buffer; cert: Buffer; ca: Buffer },
  sites: readonly FleetSite[],
  revokedCertificateSha256: readonly string[] = [],
) {
  if (
    revokedCertificateSha256.length > 128 ||
    revokedCertificateSha256.some((hash) => !/^[a-fA-F0-9]{64}$/.test(hash))
  )
    throw new Error('Invalid revoked certificate fingerprints');
  const revoked = new Set(revokedCertificateSha256.map((hash) => hash.toLowerCase()));
  if (
    !sites.length ||
    sites.length > FLEET_LIMITS.maxAgents ||
    new Set(agentIdsOf(sites)).size !== sites.length
  )
    throw new Error('Invalid agent registry');
  const agentIds = agentIdsOf(sites);
  const app = Fastify({
    https: { ...tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    bodyLimit: FLEET_LIMITS.maxMessageBytes,
    logger: false,
  });
  app.addHook('preHandler', async (request, reply) => {
    const socket = request.raw.socket as TLSSocket;
    const peer = socket.getPeerCertificate();
    const agentId = peer?.subject?.CN;
    if (!socket.authorized || typeof agentId !== 'string' || !agentIds.includes(agentId))
      return reply.code(403).send({ error: 'Unregistered agent identity' });
    const raw = peer.raw;
    if (!raw || revoked.has(createHash('sha256').update(raw).digest('hex')))
      return reply.code(403).send({ error: 'Revoked agent certificate' });
    // Presence/expiry bookkeeping must never refuse an otherwise valid request.
    const expiresAt = Date.parse(peer.valid_to);
    if (Number.isFinite(expiresAt)) {
      const site = siteOf(sites, agentId);
      if (site) void coordinator.recordPresence(agentId, site, expiresAt).catch(() => undefined);
    }
  });
  const base = {
    type: 'object',
    additionalProperties: false,
    required: ['runId'],
    properties: { runId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' } },
  };
  const identity = (socket: TLSSocket) => socket.getPeerCertificate().subject.CN as string;
  // Work discovery for a resident site worker: the certificate identity asks for
  // the shard already planned for it, without having to know the runId. The queue
  // is fleet_shards_v1 (PENDING rows); there is no second work table.
  app.get('/internal/fleet/work', async (request) => ({
    assignment: await coordinator.claimNext(identity(request.raw.socket as TLSSocket)),
  }));
  app.post<{ Body: { runId: string } }>(
    '/internal/fleet/claim',
    { schema: { body: base } },
    async (request) => ({
      assignment: await coordinator.claim(
        request.body.runId,
        identity(request.raw.socket as TLSSocket),
      ),
    }),
  );
  app.post<{
    Body: { runId: string; attemptId: string; sequence: number; progress?: FleetProgress };
  }>(
    '/internal/fleet/heartbeat',
    {
      schema: {
        body: {
          ...base,
          required: ['runId', 'attemptId', 'sequence'],
          properties: {
            ...base.properties,
            attemptId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' },
            sequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            progress: {
              type: 'object',
              additionalProperties: false,
              required: ['sent', 'successful', 'failed', 'elapsedSec', 'actualRps'],
              properties: {
                sent: { type: 'integer', minimum: 0 },
                successful: { type: 'integer', minimum: 0 },
                failed: { type: 'integer', minimum: 0 },
                elapsedSec: { type: 'number', minimum: 0 },
                actualRps: { type: 'number', minimum: 0 },
              },
            },
          },
        },
      },
    },
    async (request) => ({
      lease: await coordinator.heartbeat(
        request.body.runId,
        identity(request.raw.socket as TLSSocket),
        request.body.attemptId,
        request.body.sequence,
        request.body.progress,
      ),
    }),
  );
  app.post<{
    Body: {
      runId: string;
      attemptId: string;
      state: 'SUCCEEDED' | 'STOPPED' | 'FAILED';
      result: Record<string, unknown>;
    };
  }>(
    '/internal/fleet/result',
    {
      schema: {
        body: {
          ...base,
          required: ['runId', 'attemptId', 'state', 'result'],
          properties: {
            ...base.properties,
            attemptId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' },
            state: { type: 'string', enum: ['SUCCEEDED', 'STOPPED', 'FAILED'] },
            result: { type: 'object' },
          },
        },
      },
    },
    async (request) => ({
      accepted: await coordinator.finish(
        request.body.runId,
        identity(request.raw.socket as TLSSocket),
        request.body.attemptId,
        request.body.state,
        request.body.result,
      ),
    }),
  );
  return app;
}
