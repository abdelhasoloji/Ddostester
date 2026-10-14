// Forced SSH command: exports the latest ciphertext, never the database or encryption key.
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
const directory = '/var/lib/ddostester-backups';
const receipt = JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'));
if (
  !/^[0-9TZ-]+-[a-f0-9-]{36}\.aesgcm$/.test(receipt.archive) ||
  !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
  receipt.encrypted !== true
)
  throw new Error('Invalid backup receipt');
const path = join(directory, receipt.archive);
const info = await stat(path);
if (!info.isFile() || info.size < 64 || info.size > 256 * 1024 * 1024 + 128)
  throw new Error('Invalid ciphertext size');
process.stdout.write(JSON.stringify({ version: 1, ...receipt, bytes: info.size }) + '\n');
await pipeline(createReadStream(path), process.stdout);
