#!/usr/bin/env node
/**
 * Render the DRS load plane: one worker Deployment per agent identity.
 *
 * Why one Deployment per agent and not `replicas: N`: every worker presents an mTLS
 * certificate whose CN is its agent id, and the coordinator's claim is atomic per shard.
 * Two replicas sharing one certificate would race for the same shard and the loser would
 * idle forever. Scaling therefore means *adding an identity*, not adding a replica.
 *
 * Usage:
 *   node render-load-plane.mjs --agents 4 --namespace ddostester-load \
 *     --image ghcr.io/owner/ddostester-lab-control@sha256:... --site vps-lab \
 *     --control https://10.8.0.1:8443 > load-plane.yaml
 *
 *   node render-load-plane.mjs --capacity-json capacity.json ... # agents from the envelope
 *
 * The capacity JSON is the body of GET /api/drs/capacity; `envelope.agents` is the number
 * of admitted agents, which is exactly how many identities the envelope expects.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};

const namespace = opt('namespace', 'ddostester-load');
const image = opt('image', '');
const site = opt('site', 'vps-lab');
const control = opt('control', 'https://10.8.0.1:8443');
const capacityJson = opt('capacity-json', '');
let agents = Number(opt('agents', '1'));

if (capacityJson) {
  const capacity = JSON.parse(readFileSync(capacityJson, 'utf8'));
  const admitted = Number(capacity?.envelope?.agents);
  if (!Number.isInteger(admitted) || admitted < 0)
    throw new Error('capacity JSON has no envelope.agents');
  agents = admitted;
}

if (!Number.isInteger(agents) || agents < 1 || agents > 500)
  throw new Error('agents must be an integer within 1–500');
if (!image) throw new Error('--image is required (use an immutable digest reference)');
if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(image))
  throw new Error('image must be pinned by digest: ghcr.io/<owner>/<repo>@sha256:<64 hex>');

const docs = [];
for (let i = 1; i <= agents; i++) {
  const id = `agent-${i}`;
  docs.push(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: drs-worker-${id}
  namespace: ${namespace}
  labels: { app: drs-worker, agent: "${id}" }
spec:
  # One replica per identity: two pods with the same certificate CN would race for the
  # same shard. Scaling is additive (another identity), not replicas.
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels: { app: drs-worker, agent: "${id}" }
  template:
    metadata:
      labels: { app: drs-worker, agent: "${id}" }
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 20
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: worker
          image: ${image}
          command: ["node", "dist/cli/fleet-worker.js"]
          env:
            - { name: FLEET_AGENT_ID, value: "${id}" }
            - { name: FLEET_CONTROL_URL, value: "${control}" }
            - { name: FLEET_SITE, value: "${site}" }
            - { name: FLEET_POLL_MS, value: "1000" }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: "1", memory: 512Mi }
          volumeMounts:
            - { name: identity, mountPath: /etc/drs/identity, readOnly: true }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: identity
          secret: { secretName: fleet-${id}, defaultMode: 0400 }
        - name: tmp
          emptyDir: { sizeLimit: 64Mi }
`);
}

process.stdout.write(docs.join('---\n'));
process.stderr.write(`rendered ${agents} worker identity(ies) in namespace ${namespace}\n`);
