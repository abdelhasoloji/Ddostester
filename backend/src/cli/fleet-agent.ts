#!/usr/bin/env node
/**
 * One-shot fleet agent: claims a single RUN-SCOPED shard, executes it, reports,
 * and exits. Used by the control plane's Kubernetes Job for the local site.
 *
 * A remote site uses `fleet-worker.ts` instead, which discovers work by identity
 * and stays resident. Both share the same outbound-only mTLS client, the same
 * trusted policy file and the same bounded execution path.
 */
import { readFile } from 'node:fs/promises';
import { runFleetAssignment } from '../modules/fleet/agent.js';
import {
  controlOrigin,
  createAgentClient,
  readAgentPolicy,
} from '../modules/fleet/agent-client.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};

const agentId = required('FLEET_AGENT_ID');
const runId = required('FLEET_RUN_ID');
const origin = controlOrigin(required('FLEET_CONTROL_URL'));
const policy = readAgentPolicy(await readFile(required('FLEET_POLICY_FILE'), 'utf8'));

const client = createAgentClient({
  origin,
  key: await readFile(required('FLEET_TLS_KEY')),
  cert: await readFile(required('FLEET_TLS_CERT')),
  ca: await readFile(required('FLEET_TLS_CA')),
});

const stop = new AbortController();
process.on('SIGTERM', () => stop.abort());
process.on('SIGINT', () => stop.abort());

try {
  const claimed = await client.claim(runId);
  if (!claimed.assignment) throw new Error('No active assignment; refusing generation');
  const item = claimed.assignment as { attemptId: string; configHash: string };
  const result = await runFleetAssignment(
    claimed.assignment,
    { ...policy, agentId },
    {
      renew: async (sequence, progress) => {
        const reply = await client.heartbeat(runId, item.attemptId, sequence, progress);
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
  const ack = await client.result(runId, item.attemptId, result.state, {
    ...result,
    claimedAssignmentHash: item.configHash,
    podUid: process.env.POD_UID ?? null,
    podIp: process.env.POD_IP ?? null,
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
  await client.close();
}
