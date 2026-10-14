import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
const output = process.argv[2];
if (!output) throw new Error('Usage: lab-manifests.mjs NEW_OUTPUT_JSON');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rendered = execFileSync(
  'kubectl',
  ['kustomize', resolve(root, 'deploy/kubernetes/overlays/k3s')],
  { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 },
);
const applications = [];
const foundation = [];
for (const object of yaml.loadAll(rendered).filter(Boolean)) {
  if (object.kind === 'Deployment' && ['lab-control', 'lab-fleet'].includes(object.metadata.name))
    applications.push(object);
  else foundation.push(object);
}
await writeFile(
  output,
  JSON.stringify({
    foundation: { apiVersion: 'v1', kind: 'List', items: foundation },
    applications: { apiVersion: 'v1', kind: 'List', items: applications },
    bootstrap: JSON.parse(readFileSync(resolve(root, 'deploy/kubernetes/bootstrap.json'), 'utf8')),
  }) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(
  JSON.stringify({ foundationResources: foundation.length, applications: applications.length }),
);
