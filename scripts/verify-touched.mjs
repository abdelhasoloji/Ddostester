#!/usr/bin/env node
/**
 * Short verification loop: format, lint and typecheck, then only the tests affected by the
 * current change.
 *
 * `npm run verify:fast` takes ~4 minutes because it lints and tests the whole repository.
 * That is right before a push, but it is too slow for the loop between two edits. This
 * script keeps the same gates on the files that changed and delegates affected-test
 * selection to vitest.
 *
 *   npm run verify:touched          # vs HEAD (staged + unstaged + untracked)
 *   npm run verify:touched -- HEAD~1
 */
import { execSync } from 'node:child_process';

const since = process.argv[2] ?? 'HEAD';
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const read = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const collect = (cmd) => {
  try {
    return read(cmd).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const changed = [
  ...new Set([
    ...collect(`git diff --name-only --diff-filter=ACM ${since}`),
    ...collect('git diff --cached --name-only --diff-filter=ACM'),
    ...collect('git ls-files --others --exclude-standard'),
  ]),
].filter((f) => !f.startsWith('node_modules/'));

const fmt = changed.filter((f) => /\.(ts|tsx|css|json|md|yml|yaml)$/.test(f));
const code = changed.filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'));

console.log(`verify:touched — ${changed.length} changed file(s) since ${since}`);
if (fmt.length) {
  run(`npx --no-install prettier --check ${fmt.map((f) => JSON.stringify(f)).join(' ')}`);
}
if (code.length) {
  run(`npx --no-install eslint ${code.map((f) => JSON.stringify(f)).join(' ')}`);
}
run('npm run --silent typecheck');

// vitest --changed selects the tests that import a changed module; when nothing relevant
// changed it exits 0 immediately.
run('npm run --silent test -w backend -- --changed');
run('npm run --silent test -w frontend -- --changed');
console.log('verify:touched: OK');
