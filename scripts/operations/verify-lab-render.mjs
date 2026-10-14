/** Read-only checks for the pinned Linux lab manifests; never applies them. */
import fs from 'node:fs';
import yaml from 'js-yaml';
import assert from 'node:assert/strict';
const [path] = process.argv.slice(2);
if (!path || fs.statSync(path).size > 1024 * 1024) throw Error('Bounded rendered YAML required');
const documents = yaml.loadAll(fs.readFileSync(path, 'utf8')).filter(Boolean);
const images = {
  'lab-control/control': 'docker.io/library/ddostester-lab-control@sha256:5a50d8220442d1e0134f61559484e03b35288e0d8e8e5f8e3cba6ab25b6321be',
  'lab-control/loopback-access': 'docker.io/library/ddostester-lab-control@sha256:5a50d8220442d1e0134f61559484e03b35288e0d8e8e5f8e3cba6ab25b6321be',
  'lab-fleet/fleet': 'docker.io/library/ddostester-lab-control@sha256:5a50d8220442d1e0134f61559484e03b35288e0d8e8e5f8e3cba6ab25b6321be',
  'lab-probe/probe': 'docker.io/library/ddostester-lab-probe@sha256:7b7173d524a23d5682fc7364657c98404dc1449b0b0a0ebe8ce55a7d301e9711',
  'lab-target/target': 'docker.io/library/ddostester-lab-target@sha256:33bbf6b979abe338a38c05771c020eb94800188721e023e7b0d7d57152d8f106',
  'lab-target/telemetry': 'docker.io/library/ddostester-lab-telemetry@sha256:a631916e75380fb214cd167b8c6183e8cee5a7a94ad73888af48e088117c8521',
  'lab-postgres/postgres': 'docker.io/library/ddostester-lab-postgres@sha256:defe9f57cd443ae60436b39134e7d5bb062511c236e1f65d603bd5fa19353a9b',
};
const found = new Set();
assert.ok(documents.length <= 128);
for (const document of documents) {
  assert.ok(['Namespace','ResourceQuota','NetworkPolicy','Service','ConfigMap','ServiceAccount','Role','RoleBinding','Deployment','StatefulSet','PersistentVolumeClaim'].includes(document.kind), 'Unexpected resource kind');
  assert.notEqual(document.kind, 'Secret', 'Secret material must be provisioned separately');
  if (document.kind === 'Service') assert.ok(!document.spec.type || document.spec.type === 'ClusterIP', 'No public service');
  const pod = document.spec?.template?.spec;
  if (!pod) continue;
  assert.equal(document.metadata.namespace, 'ddostester-lab');
  assert.equal(document.spec.replicas, 1, 'Lab workloads remain singletons');
  assert.ok(!pod.hostNetwork && !pod.hostPID && !pod.hostIPC);
  assert.ok(!pod.initContainers?.length, 'Unreviewed init containers');
  for (const container of pod.containers) {
    const key = document.metadata.name + '/' + container.name;
    assert.ok(!found.has(key), 'Duplicate workload identity');
    assert.equal(container.image, images[key], 'Unexpected release image: ' + key);
    assert.equal(container.imagePullPolicy, 'Never');
    assert.ok(!container.securityContext?.privileged);
    found.add(key);
    if (key === 'lab-control/control') {
      assert.equal(container.env.find(e => e.name === 'FLEET_AGENT_IMAGE')?.value, container.image);
      assert.equal(container.env.find(e => e.name === 'FLEET_ENABLED')?.value, '1');
      assert.equal(container.env.find(e => e.name === 'SCHEDULER')?.value, 'off');
    }
  }
}
assert.deepEqual([...found].sort(), Object.keys(images).sort());
console.log(JSON.stringify({verifiedRelease: 'linux-source-06', workloads: found.size, deploymentExecuted: false}));
