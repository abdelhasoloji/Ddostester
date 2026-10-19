import { Agent, fetch } from 'undici';
import { readBoundedBody } from '../../util/http-body.js';
import { FLEET_LIMITS, withinCeiling, type HardCaps } from '../../config/limits.js';
import type { FleetProgress } from './progress.js';

export interface FleetPolicy {
  allowedHosts: string[];
  allowedPorts: number[];
  caps: HardCaps;
}

/** Trusted policy file written by the operator: bounded caps, explicit hosts. */
export function readAgentPolicy(raw: string): FleetPolicy {
  const policy = JSON.parse(raw) as FleetPolicy;
  if (
    !withinCeiling(policy.caps) ||
    !Array.isArray(policy.allowedHosts) ||
    !policy.allowedHosts.every((host) => typeof host === 'string') ||
    !Array.isArray(policy.allowedPorts) ||
    !policy.allowedPorts.every((port) => Number.isInteger(port) && port > 0 && port <= 65535)
  )
    throw new Error('Invalid trusted fleet policy');
  return policy;
}

/** The control plane is HTTPS-only and must not carry credentials in its URL. */
export function controlOrigin(raw: string): URL {
  const origin = new URL(raw);
  if (origin.protocol !== 'https:' || origin.username || origin.password)
    throw new Error('Fleet control requires HTTPS');
  return origin;
}

/** Every control response is a JSON object; anything else is refused. */
export function parseControlResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid fleet response');
  return value as Record<string, unknown>;
}

export interface AgentClient {
  /** Run-scoped claim (legacy one-shot agent). */
  claim(runId: string): Promise<Record<string, unknown>>;
  /** Resident work discovery: the shard planned for this certificate identity. */
  work(): Promise<Record<string, unknown>>;
  heartbeat(
    runId: string,
    attemptId: string,
    sequence: number,
    progress?: FleetProgress,
  ): Promise<Record<string, unknown>>;
  result(
    runId: string,
    attemptId: string,
    state: 'SUCCEEDED' | 'STOPPED' | 'FAILED',
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * The outbound-only mTLS client both fleet entrypoints share. It never listens:
 * every call is a request the agent originates, so a remote site needs no inbound
 * port and no cluster credentials.
 */
export function createAgentClient(opts: {
  origin: URL;
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
}): AgentClient {
  const dispatcher = new Agent({
    connect: {
      key: opts.key,
      cert: opts.cert,
      ca: opts.ca,
      rejectUnauthorized: true,
    },
  });
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, opts.origin), {
      method: 'POST',
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(FLEET_LIMITS.heartbeatMs),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Fleet control request refused');
    }
    return parseControlResponse(
      JSON.parse(
        new TextDecoder().decode(
          await readBoundedBody(
            response.body as unknown as ReadableStream<Uint8Array>,
            FLEET_LIMITS.maxMessageBytes,
          ),
        ),
      ),
    );
  }
  return {
    claim: (runId) => post('/internal/fleet/claim', { runId }),
    work: async () => {
      const response = await fetch(new URL('/internal/fleet/work', opts.origin), {
        method: 'GET',
        dispatcher,
        redirect: 'error',
        signal: AbortSignal.timeout(FLEET_LIMITS.heartbeatMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Fleet control request refused');
      }
      return parseControlResponse(
        JSON.parse(
          new TextDecoder().decode(
            await readBoundedBody(
              response.body as unknown as ReadableStream<Uint8Array>,
              FLEET_LIMITS.maxMessageBytes,
            ),
          ),
        ),
      );
    },
    heartbeat: (runId, attemptId, sequence, progress) =>
      post('/internal/fleet/heartbeat', { runId, attemptId, sequence, progress }),
    result: (runId, attemptId, state, payload) =>
      post('/internal/fleet/result', { runId, attemptId, state, result: payload }),
    close: async () => {
      await dispatcher.destroy();
    },
  };
}
