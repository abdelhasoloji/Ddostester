// Reads a protected systemd environment file without executing it as shell code.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const [envfile, action = 'check'] = process.argv.slice(2);
if (!envfile || !['check', 'migrate'].includes(action))
  throw new Error('Usage: account-preflight.mjs ENVFILE [check|migrate]');
const env = { ...process.env };
for (const line of (await readFile(envfile, 'utf8')).split('\n')) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 1) throw new Error('Malformed environment file');
  const key = line.slice(0, i).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('Invalid environment key');
  let value = line.slice(i + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    value = value.slice(1, -1);
  env[key] = value;
}
const args =
  action === 'migrate'
    ? ['backend/dist/cli/migrate-users.js', '--apply']
    : [
        '--input-type=module',
        '-e',
        `
import {createStore} from './backend/dist/store/index.js';
import {initAuth} from './backend/dist/auth/guard.js';
import {configureAccounts} from './backend/dist/auth/single-user.js';
const store = await createStore();
try { await configureAccounts(store, initAuth()); console.log('Account policy preflight passed'); } finally {await store.close();}
`,
      ];
const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
