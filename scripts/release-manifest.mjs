import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
const root = process.cwd();
const assets = {};
async function collect(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await collect(path);
    else
      assets['/' + relative(join(root, 'frontend/dist'), path)] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
}
await collect(join(root, 'frontend/dist'));
const build = JSON.parse(await readFile(join(root, 'backend/dist/build-info.json'), 'utf8'));
await writeFile(
  join(root, 'release-manifest.json'),
  JSON.stringify({ schemaVersion: 1, build, assets }, null, 2) + '\n',
);
