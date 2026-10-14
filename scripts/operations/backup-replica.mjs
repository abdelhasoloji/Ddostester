import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
const directory = '/var/lib/ddostester-backup-replica';
const child = spawn(
  '/usr/bin/ssh',
  [
    '-i',
    '/etc/ddostester-backup-replica/source-readonly.key',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UserKnownHostsFile=/etc/ddostester-backup-replica/known_hosts',
    '-o',
    'ConnectTimeout=12',
    'root@31.31.74.228',
  ],
  { stdio: ['ignore', 'pipe', 'ignore'] },
);
const done = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) =>
    code === 0 ? resolve() : reject(new Error('Ciphertext export failed')),
  );
});
done.catch(() => {});
const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
const temporary = join(directory, `.incoming-${randomUUID()}`);
let file;
let receipt;
let header = Buffer.alloc(0);
let received = 0;
const hash = createHash('sha256');
try {
  for await (let chunk of child.stdout) {
    if (!receipt) {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf(10);
      if (end === -1) {
        if (header.length > 4096) throw new Error('Oversized export header');
        continue;
      }
      if (end > 4096) throw new Error('Oversized export header');
      receipt = JSON.parse(header.subarray(0, end).toString());
      if (
        receipt.version !== 1 ||
        receipt.encrypted !== true ||
        !/^[0-9TZ-]+-[a-f0-9-]{36}\.aesgcm$/.test(receipt.archive) ||
        !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
        !Number.isSafeInteger(receipt.bytes) ||
        receipt.bytes < 64 ||
        receipt.bytes > 256 * 1024 * 1024 + 128
      )
        throw new Error('Invalid export header');
      file = await open(temporary, 'wx', 0o600);
      chunk = header.subarray(end + 1);
      header = Buffer.alloc(0);
    }
    received += chunk.length;
    if (received > receipt.bytes) throw new Error('Export byte budget exceeded');
    hash.update(chunk);
    // FileHandle.write may write fewer bytes than requested.
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
      if (bytesWritten === 0) throw new Error('Replica write stalled');
      offset += bytesWritten;
    }
  }
  await done;
  if (!receipt || received !== receipt.bytes || hash.digest('hex') !== receipt.sha256)
    throw new Error('Ciphertext integrity verification failed');
  await file.sync();
  await file.close();
  file = undefined;
  const archive = join(directory, receipt.archive);
  // Hard link gives exclusive publication: existing archives cannot be overwritten.
  const { link } = await import('node:fs/promises');
  try {
    await link(temporary, archive);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = createHash('sha256');
    for await (const chunk of createReadStream(archive)) existing.update(chunk);
    if (existing.digest('hex') !== receipt.sha256) throw new Error('Existing replica differs');
  }
  const proof = { ...receipt, replicatedAt: new Date().toISOString() };
  const pending = join(directory, `.receipt-${randomUUID()}`);
  await writeFile(pending, JSON.stringify(proof) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(pending, join(directory, 'latest.json'));
  console.log(JSON.stringify({ encryptedReplica: true, bytes: received, sha256: receipt.sha256 }));
} finally {
  clearTimeout(timer);
  child.kill('SIGKILL');
  await file?.close();
  await rm(temporary, { force: true });
}
