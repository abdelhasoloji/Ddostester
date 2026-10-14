// Reproducible local PostgreSQL and encrypted recovery gate, never an application DB.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm, open, stat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = process.argv[2] && resolve(process.argv[2]);
if (!directory || directory === root || directory.startsWith(root + '/'))
  throw new Error('Provide a new owner-private evidence directory outside the checkout.');
if ((await stat(dirname(directory))).mode & 0o077)
  throw new Error('Evidence parent must be owner-private.');
const actualParent = await realpath(dirname(directory));
if (actualParent === root || actualParent.startsWith(root + '/'))
  throw new Error('Evidence must stay outside the checkout, including symlink parents.');
await mkdir(directory, { mode: 0o700 });
const command = (binary, args, options = {}) =>
  new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (bytes) => {
      output = (output + bytes).slice(-8192);
    });
    child.stderr.on('data', (bytes) => {
      output = (output + bytes).slice(-8192);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveCommand({ code, output });
    });
  });
const context = (await command('docker', ['context', 'show'])).output.trim();
const docker = (args) => command('docker', ['--context', context, ...args]);
const contextInfo = await docker([
  'context',
  'inspect',
  context,
  '--format',
  '{{.Endpoints.docker.Host}}',
]);
if (contextInfo.code !== 0 || !contextInfo.output.trim().startsWith('unix://'))
  throw new Error('This gate requires a local Unix-socket Docker context.');
const image = await docker(['image', 'inspect', 'postgres:16', '--format', '{{.Id}}']);
if (image.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image.output.trim()))
  throw new Error('A cached PostgreSQL 16 image is required; no image is downloaded.');
const imageId = image.output.trim();
const nonce = randomBytes(8).toString('hex');
const name = 'ddostester-pg-gate-' + nonce;
const networkName = name + '-network';
const password = randomBytes(24).toString('hex');
const credentials = join(directory, 'temporary-postgres.env');
let containerId;
let networkId;
const results = {};
const runGate = async (nameOfGate, binary, args, env) => {
  const file = await open(join(directory, nameOfGate + '.log'), 'wx', 0o600);
  try {
    const code = await new Promise((resolveGate, reject) => {
      const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', file.fd, file.fd] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (value) => {
        clearTimeout(timer);
        resolveGate(value);
      });
    });
    results[nameOfGate] = code;
    if (code !== 0) throw new Error(nameOfGate + ' failed; private diagnostics retained.');
  } finally {
    await file.close();
  }
};
const cleanup = async () => {
  if (!containerId) {
    const found = await docker([
      'inspect',
      name,
      '--format',
      '{{.Id}} {{index .Config.Labels "ddostester.gate"}}',
    ]);
    if (found.code === 0) {
      const owned = /^([a-f0-9]{64}) ([a-f0-9]{16})$/.exec(found.output.trim());
      if (!owned || owned[2] !== nonce)
        throw new Error('Unexpected container identity; no resource removed.');
      containerId = owned[1];
    }
  }
  if (containerId) {
    const inspected = await docker([
      'inspect',
      containerId,
      '--format',
      '{{.Id}} {{index .Config.Labels "ddostester.gate"}}',
    ]);
    if (inspected.output.trim() !== containerId + ' ' + nonce)
      throw new Error('Cleanup identity mismatch; no container removed.');
    const removed = await docker(['rm', '--force', containerId]);
    const absent = await docker([
      'ps',
      '--all',
      '--filter',
      'id=' + containerId,
      '--format',
      '{{.ID}}',
    ]);
    if (removed.code !== 0 || absent.code !== 0 || absent.output.trim() !== '')
      throw new Error('Owned gate container cleanup unconfirmed.');
    await writeFile(
      join(directory, 'cleanup.json'),
      JSON.stringify({ containerId, removed: true, absenceVerified: true }),
      { flag: 'wx', mode: 0o600 },
    );
  }
  if (networkId) {
    const identity = await docker([
      'network',
      'inspect',
      networkId,
      '--format',
      '{{.Id}} {{index .Labels "ddostester.gate"}}',
    ]);
    if (identity.output.trim() !== networkId + ' ' + nonce)
      throw new Error('Gate network identity mismatch.');
    const removed = await docker(['network', 'rm', networkId]);
    const absent = await docker([
      'network',
      'ls',
      '--filter',
      'id=' + networkId,
      '--format',
      '{{.ID}}',
    ]);
    if (removed.code !== 0 || absent.code !== 0 || absent.output.trim() !== '')
      throw new Error('Gate network cleanup unconfirmed.');
    await writeFile(
      join(directory, 'network-cleanup.json'),
      JSON.stringify({ networkId, removed: true, absenceVerified: true }),
      { flag: 'wx', mode: 0o600 },
    );
  }
  await rm(credentials, { force: true });
};
let failure;
try {
  const network = await docker([
    'network',
    'create',
    '--label',
    'ddostester.gate=' + nonce,
    '--label',
    'ddostester.purpose=local-postgres-gate',
    networkName,
  ]);
  if (network.code !== 0 || !/^[a-f0-9]{64}$/.test(network.output.trim()))
    throw new Error('Disposable gate network creation failed.');
  networkId = network.output.trim();
  await writeFile(credentials, `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=ddostester_gate\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  const created = await docker([
    'run',
    '--detach',
    '--pull=never',
    '--name',
    name,
    '--network',
    networkId,
    '--label',
    'ddostester.purpose=local-postgres-gate',
    '--label',
    'ddostester.gate=' + nonce,
    '--user',
    '999:999',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--cpus',
    '0.5',
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,noexec,nosuid,size=536870912,uid=999,gid=999,mode=0700',
    '--tmpfs',
    '/var/run/postgresql:rw,noexec,nosuid,size=16777216,uid=999,gid=999',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16777216,uid=999,gid=999',
    '--publish',
    '127.0.0.1::5432',
    '--env-file',
    credentials,
    imageId,
  ]);
  if (created.code !== 0) throw new Error('Disposable PostgreSQL startup failed.');
  containerId = created.output.trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Invalid created container identity.');
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      (await docker(['exec', containerId, 'pg_isready', '-U', 'postgres', '-d', 'ddostester_gate']))
        .code === 0
    ) {
      ready = true;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready.');
  const published = await docker(['port', containerId, '5432/tcp']);
  const match = /^127\.0\.0\.1:([0-9]+)$/.exec(published.output.trim());
  if (!match) throw new Error('Gate database must be published only on loopback.');
  const url = `postgres://postgres:${password}@127.0.0.1:${match[1]}/ddostester_gate`;
  const env = {
    ...process.env,
    DATABASE_URL_TEST: url,
    REQUIRE_POSTGRES_TESTS: '1',
    PG_TOOLS_CONTAINER: name,
    DOCKER_CONTEXT: context,
  };
  await runGate('postgres-tests', 'npm', ['run', 'test:postgres', '--workspace', 'backend'], env);
  await runGate('recovery-check', process.execPath, ['scripts/operations/recovery-check.mjs'], env);
  if (process.argv[3] === '--browser-single') {
    await runGate(
      'single-postgres-browser',
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.single.config.ts'],
      { ...env, DATABASE_URL: url, E2E_DISPOSABLE_POSTGRES: '1' },
    );
  }
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        results,
        nodeVersion: process.version,
        context,
        containerId,
        imageId,
        scope: 'dedicated-local-postgres16-loopback',
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
} catch (error) {
  failure = error;
}
try {
  await cleanup();
} catch (error) {
  throw failure
    ? new AggregateError([failure, error], 'Gate and cleanup failed; private evidence retained.')
    : error;
}
if (failure) throw failure;
console.log(JSON.stringify({ results, evidence: directory, cleaned: true }));
