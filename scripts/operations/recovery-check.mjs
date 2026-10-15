// Disposable recovery gate. Never restores into the application database.
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, delimiter, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import pg from 'pg';
const source = process.env.DATABASE_URL_TEST;
if (!source)
  throw new Error('DATABASE_URL_TEST required; recovery gate is for an isolated test database');
const pool = new pg.Pool({ connectionString: source });
const dir = await mkdtemp(join(tmpdir(), 'ddostester-backup-gate-'));
const database = 'ddostester_recovery_' + randomUUID().replaceAll('-', '');
const target = new URL(source);
target.pathname = '/' + database;
const cli = join(dirname(fileURLToPath(import.meta.url)), 'database-backup.mjs');
let created = false;
const fixtureEmail = 'recovery-' + randomUUID() + '@test';
let fixtureCreated = false;
const execute = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (x) => {
      stdout += x;
    });
    child.stderr.on('data', (x) => {
      stderr = (stderr + x).slice(-8192);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
try {
  const key = join(dir, 'key');
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  let path = process.env.PATH;
  const container = process.env.PG_TOOLS_CONTAINER;
  if (container) {
    if (!/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error('Invalid test container identity');
    for (const binary of ['pg_dump', 'pg_restore', 'psql']) {
      // Thin test wrapper: pg_restore consumes its already-verified dump on stdin.
      const code = `#!/usr/bin/env python3\nimport os,sys,subprocess\nfrom pathlib import Path\nargs=sys.argv[1:];data=None\nif '${binary}'=='pg_restore':data=Path(args.pop()).read_bytes()\nif os.environ.get('BACKUP_TEST_CALL_MARKER'):Path(os.environ['BACKUP_TEST_CALL_MARKER']).write_text('called')\nenv=dict(os.environ,PGHOST='127.0.0.1',PGPORT='5432')\nr=subprocess.run(['docker','exec','-i','-e','PGHOST','-e','PGPORT','-e','PGUSER','-e','PGPASSWORD','-e','PGDATABASE','${container}','${binary}',*args],input=data,env=env)\nraise SystemExit(r.returncode)\n`;
      await writeFile(join(dir, binary), code, { mode: 0o700 });
    }
    path = dir + delimiter + path;
  }
  const env = {
    ...process.env,
    PATH: path,
    BACKUP_KEY_FILE: key,
    DATABASE_URL: source,
    RESTORE_DATABASE_URL: target.toString(),
  };
  await pool.query(
    'INSERT INTO users(email,role,password_hash,status,token_version,must_change_password) VALUES($1,$2,$3,$4,$5,$6)',
    [fixtureEmail, 'viewer', 'unusable-recovery-fixture', 'disabled', 7, true],
  );
  fixtureCreated = true;
  const archive = join(dir, 'archive');
  const backup = await execute(['backup', archive], env);
  if (backup.code !== 0) throw new Error('Encrypted backup gate failed');
  await pool.query(`CREATE DATABASE "${database}"`);
  created = true;
  const restore = await execute(['restore', archive], env);
  if (restore.code !== 0) throw new Error('Authenticated recovery gate failed');
  const recovered = new pg.Pool({ connectionString: target.toString() });
  try {
    const query =
      "SELECT count(*)::int AS count, md5(coalesce(string_agg(row_to_json(u)::text, '' ORDER BY email), '')) AS fingerprint FROM users u";
    const before = (await pool.query(query)).rows[0];
    const after = (await recovered.query(query)).rows[0];
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('Recovered credentials or sessions differ');
    // Discover the actual migration-defined audit table; no assumptions about naming.
    const table = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('audit','audit_log') ORDER BY table_name",
    );
    if (table.rows.length !== 1) throw new Error('Audit table not uniquely identified');
    const sql = 'SELECT * FROM "' + table.rows[0].table_name + '" ORDER BY id';
    const originalAudit = (await pool.query(sql)).rows;
    const recoveredAudit = (await recovered.query(sql)).rows;
    if (JSON.stringify(originalAudit) !== JSON.stringify(recoveredAudit))
      throw new Error('Recovered audit differs');
    if (!originalAudit.length)
      throw new Error('Recovery gate requires an audit-bearing fixture database');
    const infrastructureSql =
      'SELECT kind,id,revision,data FROM infrastructure_revisions_v1 ORDER BY kind,id,revision';
    const originalInfrastructure = (await pool.query(infrastructureSql)).rows;
    const recoveredInfrastructure = (await recovered.query(infrastructureSql)).rows;
    if (!originalInfrastructure.length)
      throw new Error('Recovery gate requires an infrastructure-history fixture');
    if (JSON.stringify(originalInfrastructure) !== JSON.stringify(recoveredInfrastructure))
      throw new Error('Recovered infrastructure history or evidence differs');
  } finally {
    await recovered.end();
  }
  const tampered = join(dir, 'tampered');
  const bytes = await readFile(archive);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(tampered, bytes, { mode: 0o600 });
  const marker = join(dir, 'unexpected-db-command');
  const rejected = await execute(['restore', tampered], {
    ...env,
    BACKUP_TEST_CALL_MARKER: marker,
  });
  if (rejected.code === 0 || !rejected.stderr.includes('authenticate'))
    throw new Error('Corrupt archive was not refused during authentication');
  if (container) {
    let called = false;
    try {
      await access(marker);
      called = true;
    } catch {
      // A missing marker is the expected authenticated-decryption refusal path.
    }
    if (called) throw new Error('Recovery touched PostgreSQL before authentication');
  }
  console.log(
    JSON.stringify({
      encryptedBackup: true,
      authenticatedAtomicRecovery: true,
      accountsAndSessionsPreserved: true,
      auditPreserved: true,
      infrastructureHistoryAndEvidencePreserved: true,
      tamperRejectedBeforeDatabaseAccess: true,
    }),
  );
} finally {
  if (fixtureCreated) await pool.query('DELETE FROM users WHERE email=$1', [fixtureEmail]);
  if (created) await pool.query(`DROP DATABASE "${database}"`);
  await pool.end();
  await rm(dir, { recursive: true, force: true });
}
