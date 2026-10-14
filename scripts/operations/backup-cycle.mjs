import { spawn } from 'node:child_process';
import { writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// No retention deletion here: replicas and recovery must be verified first.
const directory = '/var/lib/ddostester-backups';
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
const archive = join(directory, `${id}.aesgcm`);
const script = join(dirname(fileURLToPath(import.meta.url)), 'database-backup.mjs');
const child = spawn(process.execPath, [script, 'backup', archive], {
  stdio: ['ignore', 'pipe', 'ignore'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
  if (output.length > 4096) child.kill('SIGKILL');
});
const timer = setTimeout(() => child.kill('SIGKILL'), 620000);
try {
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Encrypted backup failed')),
    );
  });
  const result = JSON.parse(output);
  if (result.encrypted !== true || !/^[a-f0-9]{64}$/.test(result.sha256))
    throw new Error('Invalid encrypted backup receipt');
  const receipt = { ...result, archive: `${id}.aesgcm`, completedAt: new Date().toISOString() };
  await writeFile(`${archive}.json`, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  const temporary = join(directory, `.latest-${id}.json`);
  await writeFile(temporary, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(directory, 'latest.json'));
  console.log(JSON.stringify(receipt));
} catch {
  await rm(archive, { force: true });
  throw new Error('Backup cycle failed; last successful receipt retained');
} finally {
  clearTimeout(timer);
}
