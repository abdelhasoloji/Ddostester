#!/usr/bin/env node
/**
 * Resident fleet worker for a remote site (M2.2).
 *
 * Outbound only: it polls the coordinator over mTLS for the shard already planned
 * for its certificate identity (`GET /internal/fleet/work`), executes it locally
 * with the bounded engine, and reports the outcome. It opens no inbound port and
 * holds no cluster credentials, so a site that cannot reach the coordinator simply
 * runs nothing.
 *
 * It also validates every assignment against its own trusted policy file before
 * executing anything: the coordinator cannot widen the caps, the destination list
 * or the ports this site accepts.
 */
import { readFile } from 'node:fs/promises';
import { runFleetAssignment } from '../modules/fleet/agent.js';
import {
  controlOrigin,
  createAgentClient,
  readAgentPolicy,
} from '../modules/fleet/agent-client.js';
import { validateAssignment } from '../modules/fleet/contract.js';
import { runWorkerLoop } from '../modules/fleet/worker.js';
import { FLEET_LIMITS } from '../config/limits.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};

const agentId = required('FLEET_AGENT_ID');
const origin = controlOrigin(required('FLEET_CONTROL_URL'));
const policy = readAgentPolicy(await readFile(required('FLEET_POLICY_FILE'), 'utf8'));
const pollMs = Number(process.env.FLEET_POLL_MS ?? 1000);
if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 30_000)
  throw new Error('FLEET_POLL_MS must be an integer between 1 and 30000');

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
  const run = await runWorkerLoop(
    {
      poll: async () => {
        const reply = await client.work();
        const raw = reply.assignment;
        if (!raw) return null;
        // The site's own policy is authoritative here: a compromised or mistaken
        // coordinator still cannot push an out-of-policy destination.
        return validateAssignment(raw, {
          agentId,
          allowedHosts: policy.allowedHosts,
          allowedPorts: policy.allowedPorts,
          caps: policy.caps,
          now: Date.now(),
        });
      },
      execute: async (assignment, signal) => {
        const result = await runFleetAssignment(
          assignment,
          { ...policy, agentId },
          {
            renew: async (sequence, progress) => {
              const reply = await client.heartbeat(
                assignment.runId,
                assignment.attemptId,
                sequence,
                progress,
              );
              return reply.lease as { leaseUntil: number } | null;
            },
          },
          signal,
        );
        return {
          ...result,
          claimedAssignmentHash: assignment.configHash,
          podUid: process.env.POD_UID ?? null,
          podIp: process.env.POD_IP ?? null,
        };
      },
      report: async (assignment, outcome) => {
        const reply = await client.result(
          assignment.runId,
          assignment.attemptId,
          outcome.state,
          outcome,
        );
        return reply.accepted === true;
      },
    },
    {
      pollMs,
      signal: stop.signal,
      maxPollFailures: FLEET_LIMITS.maxAgents * 2,
      onEvent: (event, detail) => console.error(JSON.stringify({ event, ...detail })),
    },
  );
  console.log(JSON.stringify({ event: 'fleet.worker.finished', agentId, ...run }));
} finally {
  await client.close();
}
