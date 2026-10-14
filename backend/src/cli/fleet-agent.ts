import { readFile } from 'node:fs/promises';
import { Agent, fetch } from 'undici';
import { runFleetAssignment } from '../modules/fleet/agent.js';
import { readBoundedBody } from '../util/http-body.js';
import { FLEET_LIMITS, withinCeiling, type HardCaps } from '../config/limits.js';
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};
const origin = new URL(required('FLEET_CONTROL_URL'));
if (origin.protocol !== 'https:' || origin.username || origin.password)
  throw new Error('Fleet control requires HTTPS');
const agentId = required('FLEET_AGENT_ID');
const runId = required('FLEET_RUN_ID');
const policy: { allowedHosts: string[]; allowedPorts: number[]; caps: HardCaps } = JSON.parse(
  await readFile(required('FLEET_POLICY_FILE'), 'utf8'),
);
if (
  !withinCeiling(policy.caps) ||
  !Array.isArray(policy.allowedHosts) ||
  !policy.allowedHosts.every((x) => typeof x === 'string') ||
  !Array.isArray(policy.allowedPorts) ||
  !policy.allowedPorts.every((x) => Number.isInteger(x) && x > 0 && x <= 65535)
)
  throw new Error('Invalid trusted fleet policy');
const dispatcher = new Agent({
  connect: {
    key: await readFile(required('FLEET_TLS_KEY')),
    cert: await readFile(required('FLEET_TLS_CERT')),
    ca: await readFile(required('FLEET_TLS_CA')),
    rejectUnauthorized: true,
  },
});
const stop = new AbortController();
process.on('SIGTERM', () => stop.abort());
process.on('SIGINT', () => stop.abort());
async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin), {
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
  const value: unknown = JSON.parse(
    new TextDecoder().decode(
      await readBoundedBody(
        response.body as unknown as ReadableStream<Uint8Array>,
        FLEET_LIMITS.maxMessageBytes,
      ),
    ),
  );
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid fleet response');
  return value as Record<string, unknown>;
}
try {
  const claimed = await post('/internal/fleet/claim', { runId });
  if (!claimed.assignment) throw new Error('No active assignment; refusing generation');
  const item = claimed.assignment as { attemptId: string; configHash: string };
  const result = await runFleetAssignment(
    claimed.assignment,
    { ...policy, agentId },
    {
      renew: async (sequence, progress) => {
        const reply = await post('/internal/fleet/heartbeat', {
          runId,
          attemptId: item.attemptId,
          sequence,
          progress,
        });
        return reply.lease as { leaseUntil: number } | null;
      },
    },
    stop.signal,
  );
  console.log(
    JSON.stringify({
      event: 'fleet.measurement.finished',
      runId,
      agentId,
      state: result.state,
      reason: result.reason,
    }),
  );
  const ack = await post('/internal/fleet/result', {
    runId,
    attemptId: item.attemptId,
    state: result.state,
    result: {
      ...result,
      claimedAssignmentHash: item.configHash,
      podUid: process.env.POD_UID ?? null,
      podIp: process.env.POD_IP ?? null,
    },
  });
  if (ack.accepted !== true) throw new Error('Final result not acknowledged');
  console.log(
    JSON.stringify({
      runId,
      agentId,
      state: result.state,
      reason: result.reason,
      acknowledged: true,
    }),
  );
} finally {
  await dispatcher.destroy();
}
