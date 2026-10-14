import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
export default async function setup(config) {
  const secret = config.webServer?.env?.AUTH_JWT_SECRET;
  if (typeof secret !== 'string' || secret.length < 32)
    throw new Error('Missing isolated browser signing secret.');
  process.env.E2E_TEST_SIGNING_SECRET = secret;
  process.env.E2E_STREAM_CONTROL_TOKEN = config.webServer.env.E2E_STREAM_CONTROL_TOKEN;
  const directory = await mkdtemp(join(tmpdir(), 'ddostester-e2e-sessions-'));
  const id = randomUUID();
  await writeFile(join(directory, '.owner'), id, { mode: 0o600 });
  process.env.E2E_SESSION_CACHE = directory;
  process.env.E2E_SESSION_CACHE_ID = id;
}
