import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
export default async function teardown() {
  const directory = process.env.E2E_SESSION_CACHE;
  if (
    !directory ||
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('ddostester-e2e-sessions-') ||
    (await readFile(join(directory, '.owner'), 'utf8')) !== process.env.E2E_SESSION_CACHE_ID
  )
    throw new Error('Unexpected session-cache identity; no directory removed.');
  await rm(directory, { recursive: true });
  delete process.env.E2E_TEST_SIGNING_SECRET;
  delete process.env.E2E_STREAM_CONTROL_TOKEN;
}
