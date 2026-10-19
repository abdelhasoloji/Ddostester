#!/usr/bin/env node
/**
 * Offline validator for the site-worker template.
 *
 *   node check-render.mjs site.env
 *
 * Substitutes worker.template.yaml from an env file, parses the result and
 * asserts the properties that matter, without a cluster or a Docker daemon.
 * Exits non-zero on the first violation. This is not a substitute for the
 * cluster's own admission checks; it catches the mistakes that are cheap to make
 * (unfilled placeholder, mutable tag, a policy above the hard ceiling).
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HARD_CAPS = { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 };
const here = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error('FAIL: ' + message);
  process.exit(1);
}

function readEnv(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) fail(`malformed line in ${basename(path)}: ${line}`);
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

const envPath = process.argv[2];
if (!envPath) fail('usage: node check-render.mjs site.env');
const env = readEnv(envPath);

for (const [key, value] of Object.entries(env))
  if (value.includes('CHANGE_ME')) fail(`${key} still contains CHANGE_ME`);

const template = readFileSync(join(here, 'worker.template.yaml'), 'utf8');
const placeholders = new Set([...template.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]));
const missing = [...placeholders].filter((key) => !env[key]);
if (missing.length) fail('missing values: ' + missing.join(', '));

const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => env[key]);
if (rendered.includes('${')) fail('unsubstituted placeholder remains');

let documents;
try {
  documents = yaml.loadAll(rendered).filter(Boolean);
} catch (error) {
  fail('template is not valid YAML after substitution: ' + error.message);
}
const kinds = documents.map((doc) => doc.kind);
if (kinds.join(',') !== 'ConfigMap,Deployment,NetworkPolicy')
  fail('unexpected objects: ' + kinds.join(', '));

const [configMap, deployment, policy] = documents;

// 1. The site's own policy: parseable and never above the hard ceiling.
let sitePolicy;
try {
  sitePolicy = JSON.parse(configMap.data['policy.json']);
} catch (error) {
  fail('policy.json is not valid JSON: ' + error.message);
}
if (!Array.isArray(sitePolicy.allowedHosts) || sitePolicy.allowedHosts.length === 0)
  fail('policy.json has no allowed hosts');
if (!Array.isArray(sitePolicy.allowedPorts) || sitePolicy.allowedPorts.some((p) => !Number.isInteger(p)))
  fail('policy.json has invalid ports');
for (const [key, ceiling] of Object.entries(HARD_CAPS))
  if (!(sitePolicy.caps?.[key] > 0) || sitePolicy.caps[key] > ceiling)
    fail(`policy.json caps.${key} must be 1..${ceiling}`);

// 2. Exactly one worker: two pods sharing a CN would race for the same shard.
if (deployment.spec.replicas !== 1) fail('Deployment must run exactly one replica');
const pod = deployment.spec.template.spec;
if (pod.automountServiceAccountToken !== false) fail('service account token must not be mounted');
const container = pod.containers?.[0];
if (!container) fail('no container');
if (!container.image.includes('@sha256:')) fail('image must be pinned by digest, not a tag');
if (container.image.includes(':latest')) fail('image uses a mutable tag');
if (!container.command?.join(' ').includes('fleet-worker.js')) fail('unexpected entrypoint');
if (container.securityContext?.readOnlyRootFilesystem !== true) fail('root filesystem must be read-only');
if (container.securityContext?.allowPrivilegeEscalation !== false)
  fail('privilege escalation must be disabled');
const names = container.env.map((entry) => entry.name);
for (const required of [
  'FLEET_CONTROL_URL',
  'FLEET_AGENT_ID',
  'FLEET_POLICY_FILE',
  'FLEET_TLS_KEY',
  'FLEET_TLS_CERT',
  'FLEET_TLS_CA',
])
  if (!names.includes(required)) fail('missing env ' + required);
const controlUrl = container.env.find((entry) => entry.name === 'FLEET_CONTROL_URL').value;
if (!controlUrl.startsWith('https://')) fail('FLEET_CONTROL_URL must be https');
const identityVolume = pod.volumes?.find((volume) => volume.secret);
if (!identityVolume?.secret?.secretName) fail('identity secret is not mounted');
if (identityVolume.secret.defaultMode !== 288) fail('identity secret mode must be 0400 (288)');

// 3. Egress only: the worker never listens.
if (policy.spec.policyTypes?.join(',') !== 'Egress') fail('NetworkPolicy must be Egress-only');
if (policy.spec.ingress) fail('NetworkPolicy must not declare ingress');

console.log(
  JSON.stringify(
    {
      ok: true,
      namespace: configMap.metadata.namespace,
      agent: container.env.find((entry) => entry.name === 'FLEET_AGENT_ID').value,
      site: env.SITE_NAME ?? '(SITE_NAME not set)',
      image: container.image,
      controlUrl,
      caps: sitePolicy.caps,
      hosts: sitePolicy.allowedHosts,
      ports: sitePolicy.allowedPorts,
      registerOnCoordinator: `FLEET_SITES must contain ${container.env.find((entry) => entry.name === 'FLEET_AGENT_ID').value}@${env.SITE_NAME ?? '<site>'}`,
      deployWith: 'envsubst < worker.template.yaml | kubectl apply -f -',
    },
    null,
    1,
  ),
);
