#!/usr/bin/env node
/**
 * Validate a rendered DRS load plane without a cluster.
 *
 *   node render-load-plane.mjs --agents 3 --image ghcr.io/o/r@sha256:… > lp.yaml
 *   node check-load-plane.mjs lp.yaml 3
 *
 * It checks the properties that make the plane safe to run, not just that it parses:
 * one Deployment per identity, unique agent ids, a digest-pinned image, non-root and
 * read-only rootfs, and a per-agent identity Secret.
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const file = process.argv[2];
const expected = Number(process.argv[3] ?? '0');
if (!file) {
  console.error('usage: check-load-plane.mjs <rendered.yaml> [expectedAgents]');
  process.exit(2);
}

const docs = yaml.loadAll(readFileSync(file, 'utf8')).filter(Boolean);
const deployments = docs.filter((d) => d.kind === 'Deployment');
const problems = [];

if (expected && deployments.length !== expected)
  problems.push(`expected ${expected} deployments, found ${deployments.length}`);

const ids = new Set();
const secrets = new Set();
for (const d of deployments) {
  const name = d.metadata?.name;
  const spec = d.spec?.template?.spec;
  const container = spec?.containers?.[0];
  const env = Object.fromEntries((container?.env ?? []).map((e) => [e.name, e.value]));
  const id = env.FLEET_AGENT_ID;
  if (!id) problems.push(`${name}: no FLEET_AGENT_ID`);
  if (id && ids.has(id)) problems.push(`${name}: duplicate agent id ${id}`);
  if (id) ids.add(id);
  if (d.spec?.replicas !== 1) problems.push(`${name}: replicas must be 1 per identity`);
  if (!/@sha256:[a-f0-9]{64}$/i.test(container?.image ?? ''))
    problems.push(`${name}: image is not pinned by digest`);
  if (spec?.securityContext?.runAsNonRoot !== true) problems.push(`${name}: must run as non-root`);
  if (container?.securityContext?.readOnlyRootFilesystem !== true)
    problems.push(`${name}: root filesystem must be read-only`);
  if (container?.securityContext?.allowPrivilegeEscalation !== false)
    problems.push(`${name}: privilege escalation must be disabled`);
  const secret = (spec?.volumes ?? []).find((v) => v.secret)?.secret?.secretName;
  if (!secret) problems.push(`${name}: no identity Secret mounted`);
  else secrets.add(secret);
}

if (ids.size !== deployments.length) problems.push('agent ids are not unique per deployment');

if (problems.length) {
  console.error('FAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`OK ${deployments.length} deployment(s), ${ids.size} identity(ies)`);
