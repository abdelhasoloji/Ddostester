// Inventory heartbeat client. Sends no workload or target traffic.
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
const [file, secondsText = '3600'] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!file || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
  throw new Error(
    'Usage: node scripts/fleet/heartbeat-agent.mjs PRIVATE_CONFIG_JSON [duration_seconds:1..86400]',
  );
const metadata = await lstat(file);
if (!metadata.isFile() || metadata.mode & 0o077 || metadata.size > 8192)
  throw new Error('Enrollment must be a private regular file (chmod 600).');
const config = JSON.parse(await readFile(file, 'utf8'));
if (
  config.schema !== 'ddostester.fleet.enrollment/v1' ||
  !/^[a-f0-9]{64}$/.test(config.token) ||
  !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.agentId) ||
  !/^[a-f0-9-]{36}$/.test(config.deviceId)
)
  throw new Error('Invalid enrollment configuration');
const origin = new URL(config.controlUrl);
if (
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  origin.pathname !== '/' ||
  !(
    origin.protocol === 'https:' ||
    (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
  )
)
  throw new Error('Use an HTTPS control origin, or loopback HTTP for a local fixture.');
const endpoint = new URL('/api/fleet/devices/' + config.deviceId + '/heartbeat', origin);
const tls = {};
for (const [field, envName] of [
  ['ca', 'FLEET_AGENT_TLS_CA'],
  ['cert', 'FLEET_AGENT_TLS_CERT'],
  ['key', 'FLEET_AGENT_TLS_KEY'],
])
  if (process.env[envName]) tls[field] = await readFile(process.env[envName]);
const stateFile = file + '.state.json';
const credentialHash = createHash('sha256').update(config.token).digest('hex');
let sequence = 0;
try {
  const stat = await lstat(stateFile);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 1024)
    throw new Error('Heartbeat state must be a private regular file');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  if (state.credentialHash === credentialHash) {
    if (!Number.isSafeInteger(state.sequence) || state.sequence < 0)
      throw new Error('Invalid heartbeat sequence');
    sequence = state.sequence;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const started = performance.now();
let stopped = false;
let active;
let wake;
const stop = () => {
  stopped = true;
  active?.destroy();
  wake?.();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
const send = () =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({
      agentId: config.agentId,
      privateIp: config.privateIp,
      sequence,
      version: process.env.FLEET_MISSION_RUNTIME === '1' ? 'fleet-mission-agent/v1' : 'inventory-heartbeat/v1',
      uptimeSec: (performance.now() - started) / 1000,
    });
    const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(
      endpoint,
      {
        ...tls,
        method: 'POST',
        signal: AbortSignal.timeout(5000),
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
          if (bytes > 8192) request.destroy(new Error('Oversized heartbeat response'));
          else output += chunk.toString('utf8');
        });
        response.on('end', () => {
          if (response.statusCode === 200) {
            try {
              if (JSON.parse(output).accepted !== true)
                throw new Error('Invalid heartbeat response');
            } catch {
              reject(new Error('Invalid heartbeat response'));
              return;
            }
          }
          resolve(response.statusCode);
        });
        response.on('error', reject);
      },
    );
    active = request;
    request.setTimeout(5000, () => request.destroy(new Error('Heartbeat timeout')));
    request.on('error', reject);
    request.end(body);
  });
let failures = 0;
while (!stopped && performance.now() - started < seconds * 1000) {
  if (!Number.isSafeInteger(++sequence)) throw new Error('Sequence exhausted');
  await writeFile(stateFile, JSON.stringify({ credentialHash, sequence }), {
    mode: 0o600,
    flag: 'w',
  });
  try {
    const code = await send();
    if (code === 200) {
      failures = 0;
      console.log('Heartbeat accepted sequence=' + sequence);
    } else if ([401, 403, 409].includes(code))
      throw new Error('Enrollment rejected; enroll this agent again.');
    else if (code !== 429 && ++failures >= 3)
      throw new Error('Control unavailable after three attempts');
  } catch (error) {
    if (stopped) break;
    if (/Enrollment rejected|three attempts/.test(error.message) || ++failures >= 3) throw error;
    console.error('Heartbeat unavailable; retrying.');
  }
  const remaining = seconds * 1000 - (performance.now() - started);
  if (remaining > 0 && !stopped)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(5000, remaining));
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
}
console.log('Heartbeat client stopped.');
