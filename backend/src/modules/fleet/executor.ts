import { KubernetesJobs } from './kubernetes.js';

/**
 * The port through which a fleet run obtains execution capacity at ONE site.
 *
 * Today the only implementation creates Kubernetes Jobs in this cluster
 * (`KubernetesJobs`). A remote site will provide its own implementation, so the
 * rest of the fleet code must depend on this interface rather than on the
 * Kubernetes client — and must never assume that "create" means "a Job in my
 * own namespace".
 *
 * The port deliberately exposes only the lifecycle the coordinator needs. It
 * carries no budget, no policy and no destination: those are decided centrally
 * (`plan()` + `authorizedEnvelope`) and travel inside the signed assignment.
 */
export interface FleetExecutor {
  /** Starts the agent for one shard; resolves to the executor-side name. */
  create(runId: string, agentId: string, durationSec: number): Promise<string>;
  /** Removes a shard's capacity (best effort, idempotent on a missing object). */
  remove(name: string): Promise<void>;
  /** Post-run evidence for one shard (metadata plus bounded log snapshot). */
  evidence(name: string): Promise<Record<string, unknown>>;
  /** Releases any connection the executor holds. */
  close(): Promise<void>;
}

/** The dedicated lab namespace; a fleet executor may not target another one. */
export const FLEET_NAMESPACE = 'ddostester-lab';

/**
 * Builds the local (in-cluster) executor. `FLEET_AGENT_IMAGE` must be
 * digest-pinned: `KubernetesJobs` refuses a mutable tag, so a pulled image
 * cannot change between runs.
 */
export function createFleetExecutor(env: NodeJS.ProcessEnv = process.env): FleetExecutor {
  const image = env.FLEET_AGENT_IMAGE;
  if (!image) throw new Error('FLEET_AGENT_IMAGE required');
  return new KubernetesJobs(FLEET_NAMESPACE, image, env);
}
