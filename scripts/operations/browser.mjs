#!/usr/bin/env node
/**
 * Start (or reuse) a dedicated Chrome with the DevTools protocol enabled, so UI verification
 * is one command instead of a manual launch.
 *
 *   node scripts/operations/browser.mjs            # open the production control plane
 *   node scripts/operations/browser.mjs http://127.0.0.1:5173/
 *   node scripts/operations/browser.mjs --close
 *
 * Why a dedicated profile: Chrome refuses remote debugging on the default profile, and the
 * debugging port is what lets a script read the page, click and screenshot. The profile
 * persists between launches, so the client certificate and the session survive a service
 * restart; only the app's own logout clears it.
 *
 * Security: while the port is open, any local process can drive that browser and reach the
 * session inside it. Close it with --close when the verification is done.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const flag = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(flag('port', '9222'));
const PROFILE = flag('profile', join(homedir(), '.cache', 'ddos-browser'));
const PIDFILE = join(PROFILE, 'cdp.pid');
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const close = args.includes('--close');
// Positional only: the values of --port and --profile are not the URL to open.
const takesValue = new Set(['--port', '--profile']);
const url =
  args.find((a, i) => !a.startsWith('--') && !takesValue.has(args[i - 1])) ??
  'https://31.31.74.228/';

const alive = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

if (close) {
  if (existsSync(PIDFILE)) {
    const pid = Number(readFileSync(PIDFILE, 'utf8'));
    try {
      process.kill(pid);
      console.log(`closed pid ${pid}`);
    } catch {
      console.log('process already gone');
    }
    rmSync(PIDFILE, { force: true });
  } else {
    console.log('no pid file; close the profile window manually');
  }
  process.exit(0);
}

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}; set CHROME_PATH.`);
  process.exit(1);
}

const existing = await alive();
if (existing) {
  console.log(`already running: ${existing.Browser} on http://127.0.0.1:${PORT}`);
  process.exit(0);
}

const child = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();
mkdirSync(PROFILE, { recursive: true });
writeFileSync(PIDFILE, String(child.pid));

for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const info = await alive();
  if (info) {
    console.log(`Chrome ${info.Browser} on http://127.0.0.1:${PORT} (profile ${PROFILE})`);
    console.log('Sign in once in that window; the profile keeps the session between runs.');
    process.exit(0);
  }
}
console.error('Chrome started but the debugging endpoint never answered.');
process.exit(1);
