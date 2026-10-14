import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { signWitness, verifyWitnesses } from './proof.mjs';
const directory = process.env.WITNESS_RECORDS_DIR ?? '/var/lib/ddostester-audit-witness/records';
const keyDir = '/etc/ddostester-audit-witness';
await mkdir(directory, { recursive: true, mode: 0o700 });
const files = (await readdir(directory))
  .filter((name) => /^\d{13}-[0-9a-f]{64}\.json$/.test(name))
  .sort();
const records = await Promise.all(
  files.map((file) => readFile(join(directory, file), 'utf8').then(JSON.parse)),
);
let privateKey;
try {
  privateKey = await readFile(join(keyDir, 'signing-key.pem'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (records.length) throw new Error('Signing key missing for an existing witness history');
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await writeFile(join(keyDir, 'signing-key.pem'), pair.privateKey, { flag: 'wx', mode: 0o600 });
  await writeFile(join(keyDir, 'signing-public.pem'), pair.publicKey, { flag: 'wx', mode: 0o644 });
  privateKey = pair.privateKey;
}
if ((await stat(join(keyDir, 'signing-key.pem'))).mode & 0o077)
  throw new Error('Witness signing key permissions are unsafe');
const publicKey = await readFile(join(keyDir, 'signing-public.pem'));
const chain = verifyWitnesses(records, publicKey);
const checkpoint = JSON.parse(
  execFileSync(
    'ssh',
    [
      '-i',
      join(keyDir, 'source-readonly.key'),
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UserKnownHostsFile=' + join(keyDir, 'known_hosts'),
      'root@31.31.74.228',
      chain.auditHead,
    ],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 8192 },
  ),
);
const signed = signWitness(checkpoint, records.at(-1), privateKey);
const proof = verifyWitnesses([...records, signed], publicKey);
const path = join(directory, Date.now() + '-' + proof.lastRecordHash + '.json');
await writeFile(path, JSON.stringify(signed) + '\n', { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify({
    witnessRecorded: true,
    records: proof.records,
    auditHead: proof.auditHead,
    signature: 'Ed25519',
  }),
);
