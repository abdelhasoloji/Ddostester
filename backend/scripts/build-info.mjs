// Writes backend/dist/build-info.json after the TypeScript build so the running
// server can report exactly which commit it serves (GET /health → version).
// Values come from the deploy's env (SHIELDTEST_*), then git, then a safe
// default — the same precedence the frontend uses. dist/ is gitignored, so this
// never dirties the working tree. Never throws: a missing git just falls back.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // backend/scripts
const backendRoot = join(here, '..'); // backend
const repoRoot = join(backendRoot, '..'); // repo root
const distDir = join(backendRoot, 'dist');

let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(readFileSync(join(backendRoot, 'package.json'), 'utf8')).version;
} catch {
  /* keep default */
}

const git = (args) => {
  try {
    return execSync(`git -C "${repoRoot}" ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};
const envOr = (name, fromGit) => {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fromGit();
};

const info = {
  version: process.env.SHIELDTEST_VERSION?.trim() || pkgVersion,
  build: envOr('SHIELDTEST_BUILD', () => git('rev-list --count HEAD')) || '0',
  commit: envOr('SHIELDTEST_COMMIT', () => git('rev-parse --short HEAD')) || 'dev',
  builtAt: new Date().toISOString(),
};

mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'build-info.json'), JSON.stringify(info));
console.log(`build-info: v${info.version}+${info.build} · ${info.commit}`);
