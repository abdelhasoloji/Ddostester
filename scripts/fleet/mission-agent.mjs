// Trusted lab worker: one claimed assignment at a time, no load retries.
import { readFile, lstat } from 'node:fs/promises';
import { request } from 'node:https';
import { runFleetAssignment } from '/app/backend/dist/modules/fleet/agent.js';
import { FLEET_LIMITS } from '/app/backend/dist/config/limits.js';
const file = process.argv[2];
const stat = await lstat(file);
if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192)
  throw new Error('Private enrollment required');
const config = JSON.parse(await readFile(file, 'utf8'));
const started = Date.now();
const origin = new URL(config.controlUrl);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/')
  throw new Error('HTTPS control origin required');
const tls = {};
for (const [field, name] of [
  ['ca', 'FLEET_AGENT_TLS_CA'],
  ['cert', 'FLEET_AGENT_TLS_CERT'],
  ['key', 'FLEET_AGENT_TLS_KEY'],
])
  tls[field] = await readFile(process.env[name]);
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
const lifetime = setTimeout(() => stop.abort(), 86400 * 1000);
let allowedOrigins = ['http://lab-target:8080'];
try {
  const policyFile = JSON.parse(await readFile('/observer/mission-policy.json', 'utf8'));
  if (
    !Array.isArray(policyFile.origins) ||
    !policyFile.origins.length ||
    policyFile.origins.length > 4
  )
    throw new Error('Invalid trusted Fleet origins');
  allowedOrigins = policyFile.origins.map((raw) => {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid trusted Fleet origin');
    return url.origin;
  });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const policy = {
  agentId: config.agentId,
  caps: {
    maxRps: FLEET_LIMITS.maxRps,
    maxConcurrency: FLEET_LIMITS.maxConcurrency,
    maxDurationSec: FLEET_LIMITS.maxDurationSec,
  },
};
async function post(action, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = request(
      new URL('/api/fleet/devices/' + config.deviceId + '/mission/' + action, origin),
      {
        ...tls,
        method: 'POST',
        signal: AbortSignal.timeout(FLEET_LIMITS.heartbeatMs),
        headers: {
          authorization: 'Bearer ' + config.token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let bytes = 0;
        let output = '';
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > FLEET_LIMITS.maxMessageBytes)
            req.destroy(new Error('Oversized control response'));
          else output += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error('Control refused'));
          try {
            resolve(JSON.parse(output));
          } catch {
            reject(new Error('Invalid control response'));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
try {
  while (!stop.signal.aborted) {
    try {
      // Le claim porte la version du runtime : c'est elle, et non un
      // heartbeat externe, qui atteste que cet agent sait exécuter un schéma v3.
      const { assignment } = await post('claim', {
        version: 'fleet-mission-agent/v2',
        uptimeSec: (Date.now() - started) / 1000,
      });
      if (assignment) {
        // The worker policy and exact endpoint are independent of the controller response.
        const target = new URL(assignment.target);
        if (!allowedOrigins.includes(target.origin)) throw new Error('Forbidden Fleet origin');
        const result = await runFleetAssignment(
          assignment,
          {
            ...policy,
            allowedHosts: [target.hostname],
            allowedPorts: [Number(target.port || (target.protocol === 'https:' ? 443 : 80))],
          },
          {
            renew: async (sequence, progress) =>
              (
                await post('renew', {
                  runId: assignment.runId,
                  attemptId: assignment.attemptId,
                  sequence,
                  progress,
                })
              ).lease,
          },
          stop.signal,
        );
        const receipt = {
          ...result,
          claimedAssignmentHash: assignment.configHash,
          podUid: process.env.POD_UID ?? null,
          podIp: process.env.POD_IP ?? null,
        };
        let accepted = false;
        // Only delivery of the same final receipt is retried; never generation.
        for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
          try {
            accepted =
              (
                await post('result', {
                  runId: assignment.runId,
                  attemptId: assignment.attemptId,
                  state: result.state,
                  result: receipt,
                })
              ).accepted === true;
          } catch {
            /* lease/deadline still stop generation independently */
          }
        }
        console.log(
          JSON.stringify({
            event: 'fleet.mission.finished',
            runId: assignment.runId,
            agentId: config.agentId,
            state: result.state,
            reason: result.reason,
            accepted,
          }),
        );
      }
    } catch {
      if (!stop.signal.aborted)
        console.error('Mission control unavailable; no assignment started.');
    }
    if (!stop.signal.aborted)
      await new Promise((resolve) => {
        const timer = setTimeout(done, 1000);
        function done() {
          clearTimeout(timer);
          stop.signal.removeEventListener('abort', done);
          resolve();
        }
        stop.signal.addEventListener('abort', done, { once: true });
      });
  }
} finally {
  clearTimeout(lifetime);
}
