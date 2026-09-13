#!/usr/bin/env node
/**
 * Generate a CHANGELOG section from Conventional Commits (the repo already writes
 * `type(scope): subject` messages). Groups commits by type into a markdown
 * section for the current package.json version.
 *
 * Usage:
 *   node scripts/changelog.mjs            # print the section for HEAD since last tag
 *   node scripts/changelog.mjs --since v0.1.0
 *   node scripts/changelog.mjs --write    # prepend the section to CHANGELOG.md
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Range: from the arg, else the most recent tag, else the whole history.
const args = process.argv.slice(2);
const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;
let since = sinceArg;
if (!since) {
  try {
    since = sh('git describe --tags --abbrev=0');
  } catch {
    since = null; // no tags yet → whole history
  }
}
const range = since ? `${since}..HEAD` : 'HEAD';

// One line per commit: `<subject>\t<short-hash>`.
const raw = sh(`git log ${range} --no-merges --pretty=format:%s%x09%h`);
const lines = raw ? raw.split('\n') : [];

// Group by Conventional-Commit type.
const TYPES = [
  ['feat', '🚀 Features'],
  ['fix', '🐛 Fixes'],
  ['perf', '⚡ Performance'],
  ['refactor', '♻️ Refactor'],
  ['docs', '📚 Docs'],
  ['test', '✅ Tests'],
  ['ci', '🔧 CI/CD'],
  ['build', '📦 Build'],
  ['chore', '🧹 Chores'],
];
const groups = new Map(TYPES.map(([k]) => [k, []]));
const other = [];

for (const line of lines) {
  const [subject, hash] = line.split('\t');
  const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (m && groups.has(m[1])) {
    const scope = m[2] ? `**${m[2]}**: ` : '';
    const bang = m[3] ? '💥 ' : '';
    groups.get(m[1]).push(`- ${bang}${scope}${m[4]} (\`${hash}\`)`);
  } else {
    other.push(`- ${subject} (\`${hash}\`)`);
  }
}

const date = new Date().toISOString().slice(0, 10);
let section = `## v${version} — ${date}\n`;
for (const [key, title] of TYPES) {
  const items = groups.get(key);
  if (items.length) section += `\n### ${title}\n${items.join('\n')}\n`;
}
if (other.length) section += `\n### Other\n${other.join('\n')}\n`;
if (lines.length === 0) section += `\n_No commits since ${since ?? 'the beginning'}._\n`;

if (args.includes('--write')) {
  const path = join(ROOT, 'CHANGELOG.md');
  const header = '# Changelog\n\nAll notable changes, grouped by Conventional-Commit type.\n\n';
  const prev = existsSync(path)
    ? readFileSync(path, 'utf8').replace(/^# Changelog[\s\S]*?\n\n/, '')
    : '';
  writeFileSync(path, header + section + '\n' + prev);
  console.error(`Wrote v${version} section to CHANGELOG.md (${lines.length} commits).`);
} else {
  process.stdout.write(section);
}
