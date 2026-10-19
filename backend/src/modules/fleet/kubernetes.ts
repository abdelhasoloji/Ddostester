import { readFile } from 'node:fs/promises';
import { Agent, fetch } from 'undici';
import { readBoundedBody } from '../../util/http-body.js';
import { FLEET_LIMITS } from '../../config/limits.js';
import type { FleetExecutor } from './executor.js';
export class KubernetesJobs implements FleetExecutor {
  private dispatcher?: Agent;
  constructor(
    private readonly namespace: string,
    private readonly image: string,
    private readonly env = process.env,
  ) {
    if (
      namespace !== 'ddostester-lab' ||
      !/^docker\.io\/library\/ddostester-lab-control@sha256:[0-9a-f]{64}$/.test(image)
    )
      throw new Error(
        'Fleet requires the dedicated lab namespace and an immutable local agent image',
      );
  }
  private async request(
    path: string,
    method: string,
    body?: unknown,
    resource: 'jobs' | 'pods' = 'jobs',
    raw = false,
  ): Promise<Record<string, unknown>> {
    const base = '/var/run/secrets/kubernetes.io/serviceaccount';
    const [token, ca, namespace] = await Promise.all([
      readFile(base + '/token', 'utf8'),
      readFile(base + '/ca.crt'),
      readFile(base + '/namespace', 'utf8'),
    ]);
    if (namespace.trim() !== this.namespace)
      throw new Error('Kubernetes identity belongs to another namespace');
    const host = this.env.KUBERNETES_SERVICE_HOST;
    const port = this.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443';
    if (!host || !/^[0-9.]+$/.test(host) || !/^[0-9]+$/.test(port))
      throw new Error('Explicit in-cluster API endpoint required');
    this.dispatcher ??= new Agent({ connect: { ca, rejectUnauthorized: true } });
    const response = await fetch(
      `https://${host}:${port}/${resource === 'jobs' ? 'apis/batch/v1' : 'api/v1'}/namespaces/${this.namespace}/${resource}${path}`,
      {
        method,
        dispatcher: this.dispatcher,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    if (method === 'DELETE' && response.status === 404) {
      await response.body?.cancel();
      return {};
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Kubernetes ${method} refused (${response.status})`);
    }
    const text = new TextDecoder().decode(
      await readBoundedBody(
        response.body as unknown as ReadableStream<Uint8Array>,
        FLEET_LIMITS.maxMessageBytes,
      ),
    );
    return raw ? { logs: text } : (JSON.parse(text) as Record<string, unknown>);
  }
  async create(runId: string, agentId: string, durationSec: number): Promise<string> {
    if (
      !/^[0-9a-f-]{36}$/.test(runId) ||
      !['one', 'two', 'three'].includes(agentId) ||
      !Number.isInteger(durationSec) ||
      durationSec < 1 ||
      durationSec > FLEET_LIMITS.maxDurationSec
    )
      throw new Error('Invalid lab Job');
    const name = `fleet-${runId}-${agentId}`;
    await this.request('', 'POST', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name, namespace: this.namespace, labels: { app: 'lab-agent', runId, agentId } },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: durationSec + Math.ceil(FLEET_LIMITS.stopTimeoutMs / 1000),
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: { labels: { app: 'lab-agent', runId, agentId } },
          spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: 2,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'agent',
                image: this.image,
                imagePullPolicy: 'Never',
                command: ['node', 'backend/dist/cli/fleet-agent.js'],
                env: [
                  { name: 'FLEET_CONTROL_URL', value: 'https://lab-fleet:8443' },
                  { name: 'FLEET_AGENT_ID', value: agentId },
                  { name: 'FLEET_RUN_ID', value: runId },
                  { name: 'FLEET_POLICY_FILE', value: '/etc/fleet-policy/policy.json' },
                  { name: 'FLEET_TLS_KEY', value: '/etc/fleet-identity/tls.key' },
                  { name: 'FLEET_TLS_CERT', value: '/etc/fleet-identity/tls.crt' },
                  { name: 'FLEET_TLS_CA', value: '/etc/fleet-identity/ca.crt' },
                  { name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
                  { name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: {
                  requests: { cpu: '100m', memory: '128Mi' },
                  limits: { cpu: '250m', memory: '256Mi' },
                },
                volumeMounts: [
                  { name: 'identity', mountPath: '/etc/fleet-identity', readOnly: true },
                  { name: 'policy', mountPath: '/etc/fleet-policy', readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: 'identity', secret: { secretName: `fleet-${agentId}`, defaultMode: 288 } },
              { name: 'policy', configMap: { name: 'fleet-policy' } },
            ],
          },
        },
      },
    });
    return name;
  }
  async remove(name: string): Promise<void> {
    if (!/^fleet-[0-9a-f-]{36}-(one|two|three)$/.test(name))
      throw new Error('Refusing unrelated Job deletion');
    await this.request('/' + name, 'DELETE', {
      propagationPolicy: 'Foreground',
      gracePeriodSeconds: 2,
    });
  }
  async evidence(name: string): Promise<Record<string, unknown>> {
    if (!/^fleet-[0-9a-f-]{36}-(one|two|three)$/.test(name))
      throw new Error('Refusing unrelated Job evidence');
    const job = await this.request('/' + name, 'GET');
    const metadata = job.metadata as { uid?: string };
    const selected = await this.request(
      '?labelSelector=' + encodeURIComponent('job-name=' + name),
      'GET',
      undefined,
      'pods',
    );
    const pods = selected.items as Record<string, unknown>[];
    if (!Array.isArray(pods) || pods.length > 1) throw new Error('Unexpected Job pod count');
    const logs = [];
    for (const pod of pods) {
      const info = pod.metadata as {
        name?: string;
        uid?: string;
        ownerReferences?: { kind: string; uid: string }[];
      };
      if (
        !info.name ||
        !/^[a-z0-9-]+$/.test(info.name) ||
        !info.ownerReferences?.some((owner) => owner.kind === 'Job' && owner.uid === metadata.uid)
      )
        throw new Error('Pod does not belong to selected Job');
      try {
        const result = await this.request(
          '/' + info.name + '/log?container=agent&limitBytes=65536&tailLines=200&timestamps=true',
          'GET',
          undefined,
          'pods',
          true,
        );
        logs.push({ podUid: info.uid, available: true, text: result.logs });
      } catch {
        logs.push({ podUid: info.uid, available: false });
      }
    }
    return {
      ...jobEvidence(job),
      logs,
      logsScope: 'snapshot-before-cleanup',
      logsAvailable: logs.length > 0 && logs.every((entry) => entry.available),
    };
  }
  async close(): Promise<void> {
    await this.dispatcher?.destroy();
  }
}

/** Select fields explicitly: admission annotations and environment values are excluded. */
export function jobEvidence(job: Record<string, unknown>): Record<string, unknown> {
  const metadata = job.metadata as Record<string, unknown> | undefined;
  const spec = job.spec as
    | {
        activeDeadlineSeconds?: number;
        backoffLimit?: number;
        template?: { spec?: { containers?: { name?: string; image?: string }[] } };
      }
    | undefined;
  const status = job.status as Record<string, unknown> | undefined;
  return {
    name: metadata?.name,
    uid: metadata?.uid,
    createdAt: metadata?.creationTimestamp,
    activeDeadlineSeconds: spec?.activeDeadlineSeconds,
    backoffLimit: spec?.backoffLimit,
    containers: spec?.template?.spec?.containers?.map(({ name, image }) => ({ name, image })),
    active: status?.active,
    succeeded: status?.succeeded,
    failed: status?.failed,
    startedAt: status?.startTime,
    completedAt: status?.completionTime,
  };
}
