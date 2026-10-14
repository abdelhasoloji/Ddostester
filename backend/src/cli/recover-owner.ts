import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createStore } from '../store/index.js';
import { recoverOwner } from '../modules/users/owner-recovery.js';

const [passwordFile, ticket] = process.argv.slice(2);
if (!passwordFile || !ticket || process.argv.length !== 4 || !process.env.DATABASE_URL)
  throw new Error('Usage: recover-owner PASSWORD_FILE TICKET; PostgreSQL configuration required');
const file = await open(passwordFile, constants.O_RDONLY | constants.O_NOFOLLOW);
let password: string;
try {
  const metadata = await file.stat();
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > 4096 ||
    metadata.uid !== process.getuid?.()
  )
    throw new Error('Password file must be an owner-private regular file of at most 4096 bytes');
  password = (await file.readFile('utf8')).replace(/\r?\n$/, '');
} finally {
  await file.close();
}
const store = await createStore();
try {
  if (store.backend !== 'postgres' || !(await store.acquireRuntimeLease()))
    throw new Error('Stop the application before administrative recovery');
  await recoverOwner(store, password, ticket);
  console.log(JSON.stringify({ recovered: true, sessionsRevoked: true, temporaryPassword: true }));
} finally {
  await store.close();
}
