import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const [manifestPath, origin = 'http://127.0.0.1:8080'] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
async function get(path) {
  const r = await fetch(new URL(path, origin), {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`Release validation failed: ${path} HTTP ${r.status}`);
  return r;
}
const health = await (await get('/health')).json();
if (
  health.version?.commit !== manifest.build.commit ||
  health.version?.build !== manifest.build.build
)
  throw new Error('Served API build does not match expected release');
if (!(await (await get('/ready')).json()).ready) throw new Error('Release is not ready');
for (const [path, hash] of Object.entries(manifest.assets)) {
  const bytes = await (await get(path)).arrayBuffer();
  if (createHash('sha256').update(Buffer.from(bytes)).digest('hex') !== hash)
    throw new Error(`Served UI differs from release: ${path}`);
}
console.log(`Verified API and UI release ${manifest.build.commit} build ${manifest.build.build}`);
