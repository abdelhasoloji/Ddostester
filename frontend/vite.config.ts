import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Build-time version stamp. Shown in the sidebar footer so anyone can tell, at a
// glance, exactly which build a running instance is serving (this is what would
// have made the stale duplicate-instance obvious immediately).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// Pin git to the repo root so the caller's cwd doesn't matter; never let a git
// failure abort the build (it just falls back).
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const git = (args: string): string | null => {
  try {
    return execSync(`git -C "${repoRoot}" ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};
// Prefer values injected by the deploy (deploy/update.sh sets these from a
// known-good git context). On the server, git inside this Vite process can fail
// even when the deploy's own git works — dubious-ownership, a sanitized HOME
// under npm, or a git-less build context — which is why the footer used to
// stick at "+0 · dev". Env first, then git, then a safe default.
const envOr = (name: string, fromGit: () => string | null): string | null => {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fromGit();
};
const commit = envOr('SHIELDTEST_COMMIT', () => git('rev-parse --short HEAD')) ?? 'dev';
// Monotonic build number = commit count on HEAD. The semver in package.json is
// stable, so this is what actually increments every commit/deploy — making the
// footer version change on each release without hand-bumping package.json.
const build = envOr('SHIELDTEST_BUILD', () => git('rev-list --count HEAD')) ?? '0';
const version = process.env.SHIELDTEST_VERSION?.trim() || pkg.version;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILD__: JSON.stringify(build),
    __APP_BUILT__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080', '/health': 'http://localhost:8080' },
  },
});
