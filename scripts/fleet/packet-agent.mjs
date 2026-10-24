// Agent de mission paquet (v2). Reçoit une assignation signée, la revalide,
// exécute le générateur et rend les paquets émis ET reçus.
//
// Usage : node packet-agent.mjs <assignment.json>
// Le binaire du générateur est fourni par l'image (drs-pktgen) ; son absence
// est une erreur, jamais un repli silencieux vers le vecteur HTTP.
import { readFile, lstat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const KEYS = [
  'agentId',
  'attemptId',
  'campaignId',
  'configHash',
  'deadline',
  'durationSec',
  'leaseUntil',
  'notBefore',
  'port',
  'pps',
  'runId',
  'schema',
  'target',
].sort();

function hash(input) {
  const { configHash: _signature, ...rest } = input;
  const ordered = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function validate(x, maxPps, now) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('assignment: not an object');
  if (Object.keys(x).sort().join(',') !== KEYS.join(','))
    throw new Error('assignment: fields mismatch');
  if (x.schema !== 'ddostester.fleet.assignment/v3')
    throw new Error('assignment: unsupported schema');
  for (const k of ['campaignId', 'runId', 'agentId', 'attemptId'])
    if (typeof x[k] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(x[k]))
      throw new Error('assignment: invalid identity');
  if (!Number.isSafeInteger(x.port) || !Number.isSafeInteger(x.pps))
    throw new Error('assignment: invalid vector');
  if (x.pps < 1 || x.pps > maxPps) throw new Error('assignment: rate exceeds the local bound');
  if (!Number.isSafeInteger(x.durationSec) || x.durationSec < 1)
    throw new Error('assignment: invalid duration');
  if (x.notBefore > now || x.deadline <= now || x.leaseUntil <= now)
    throw new Error('assignment: expired');
  if (x.deadline - x.notBefore > x.durationSec * 1000)
    throw new Error('assignment: window exceeds duration');
  const expected = Buffer.from(hash(x), 'hex');
  const given = Buffer.from(String(x.configHash), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw new Error('assignment: hash mismatch');
  return x;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: packet-agent.mjs <assignment.json>');
  process.exit(2);
}
const stat = await lstat(file);
if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192) {
  console.error('assignment file must be private (mode 600) and small');
  process.exit(2);
}
const maxPps = Number(process.env.PACKET_MAX_PPS || 50000);
const binary = process.env.PACKET_GENERATOR || '/app/drs-pktgen';
// Le générateur forge l'en-tête IP : sans l'adresse réelle de l'agent, il
// enverrait des paquets à source forgée que l'hébergeur filtre en sortie
// (constaté : 0 arrivée). La source est donc obligatoire et vérifiée ici.
const source = process.env.PACKET_SOURCE_IP;
const ipv4 = (value) =>
  typeof value === 'string' &&
  /^(\d{1,3}\.){3}\d{1,3}$/.test(value) &&
  value.split('.').every((part) => Number(part) <= 255);
if (!ipv4(source)) throw new Error("PACKET_SOURCE_IP must be this agent's IPv4 source address");
const assignment = validate(JSON.parse(await readFile(file, 'utf8')), maxPps, Date.now());

const started = Date.now();
const child = spawn(
  binary,
  [
    assignment.target,
    String(assignment.port),
    String(assignment.pps),
    String(assignment.durationSec),
  ],
  {
    env: { ...process.env, ALLOW_TARGETS: new URL(assignment.target).hostname, SRC_IP: source },
  },
);
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const code = await new Promise((resolve) => child.on('close', resolve));
const sent = Number((out.match(/sent=(\d+)/) || [])[1] || 0);
// Le compteur côté cible est lu par l'orchestrateur autour de l'émission. Il
// nous le remet une fois le tir terminé ; sans lui, on ne prétend pas savoir
// ce qui est arrivé. `PACKET_RECEIVED` en environnement reste accepté pour un
// lancement hors orchestrateur.
let received = null;
if (typeof process.send === 'function') {
  process.send({ event: 'packet.emitted', sent });
  received = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    process.once('message', (message) => {
      clearTimeout(timer);
      const value = message?.PACKET_RECEIVED;
      resolve(Number.isSafeInteger(value) && value >= 0 ? value : null);
    });
  });
}
if (received === null && process.env.PACKET_RECEIVED !== undefined)
  received = Number(process.env.PACKET_RECEIVED);
if (!Number.isSafeInteger(received) || received < 0) received = null;

process.stdout.write(
  JSON.stringify(
    {
      agentId: assignment.agentId,
      attemptId: assignment.attemptId,
      campaignId: assignment.campaignId,
      exitCode: code,
      packetsSent: sent,
      packetsReceived: received,
      pps: assignment.pps,
      port: assignment.port,
      durationSec: assignment.durationSec,
      elapsedMs: Date.now() - started,
      accepted: code === 0 && sent > 0 && received !== null && received >= sent * 0.99,
    },
    null,
    1,
  ) + '\n',
);
process.exit(code === 0 ? 0 : 1);
