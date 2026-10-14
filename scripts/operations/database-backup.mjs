// Authenticated encryption; recovery verifies the whole archive before touching the target DB.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, appendFile, mkdtemp, rm, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const MAGIC = Buffer.from('DDOSTESTER_BACKUP_V1\n');
const [mode, path] = process.argv.slice(2);
if (!['backup', 'restore'].includes(mode) || !path)
  throw new Error('Usage: database-backup.mjs backup|restore ARCHIVE');
const keyPath = process.env.BACKUP_KEY_FILE;
if (!keyPath || (await stat(keyPath)).mode & 0o077)
  throw new Error('BACKUP_KEY_FILE must be private to its owner');
const key = await readFile(keyPath);
if (key.length !== 32) throw new Error('Backup key must contain exactly 32 random bytes');
const maxBytes = Number(process.env.BACKUP_MAX_BYTES ?? 256 * 1024 * 1024);
if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024 * 1024)
  throw new Error('Invalid backup byte budget');
const pgEnv = (raw) => {
  const url = new URL(raw ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  )
    throw new Error('Explicit PostgreSQL database URL required');
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') || 'prefer',
  };
};
function command(binary, args, env) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${binary} failed`))));
  }).finally(() => clearTimeout(timer));
  // Pipe failure must not leave a child or an unhandled rejection.
  done.catch(() => {});
  return { child, done };
}
if (mode === 'backup') {
  const sourceEnv = pgEnv(process.env.DATABASE_URL);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, iv]);
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  await new Promise((resolve, reject) => {
    output.once('open', resolve);
    output.once('error', reject);
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const dump = command('pg_dump', ['--format=custom', '--no-owner', '--no-acl'], sourceEnv);
  let bytes = 0;
  const budget = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error('Backup byte budget exceeded') : null, chunk);
    },
  });
  try {
    output.write(header);
    await pipeline(dump.child.stdout, budget, cipher, output);
    await dump.done;
    await appendFile(path, cipher.getAuthTag());
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    console.log(
      JSON.stringify({
        encrypted: true,
        algorithm: 'AES-256-GCM',
        dumpBytes: bytes,
        sha256: hash.digest('hex'),
      }),
    );
  } catch (error) {
    dump.child.kill('SIGKILL');
    await rm(path, { force: true });
    throw error;
  }
} else {
  const target = process.env.RESTORE_DATABASE_URL;
  if (!target || target === process.env.DATABASE_URL)
    throw new Error('RESTORE_DATABASE_URL must select a separate empty recovery database');
  const info = await stat(path);
  const headerLength = MAGIC.length + 12;
  if (info.size < headerLength + 16 || info.size > maxBytes + headerLength + 16)
    throw new Error('Invalid archive size');
  const file = await open(path, 'r');
  const header = Buffer.alloc(headerLength);
  const tag = Buffer.alloc(16);
  try {
    await file.read(header, 0, header.length, 0);
    await file.read(tag, 0, 16, info.size - 16);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid archive format');
  const dir = await mkdtemp(join(tmpdir(), 'ddostester-recovery-'));
  const plaintext = join(dir, 'verified.dump');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(path, { start: headerLength, end: info.size - 17 }),
      decipher,
      createWriteStream(plaintext, { flags: 'wx', mode: 0o600 }),
    );
    const env = pgEnv(target);
    const check = command(
      'psql',
      [
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--command',
        "SELECT count(*) FROM pg_tables WHERE schemaname='public';",
      ],
      env,
    );
    let tables = '';
    for await (const chunk of check.child.stdout) tables += chunk;
    await check.done;
    if (tables.trim() !== '0') throw new Error('Recovery database must be empty');
    const restore = command(
      'pg_restore',
      [
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        '--dbname',
        env.PGDATABASE,
        plaintext,
      ],
      env,
    );
    restore.child.stdout.resume();
    await restore.done;
    console.log(JSON.stringify({ authenticated: true, restored: true, atomicRestore: true }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
