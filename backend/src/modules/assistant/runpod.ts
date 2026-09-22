/**
 * assistant/runpod.ts — power the self-hosted assistant GPU pod on/off.
 *
 * SCOPE / SAFETY: this manages the *lifecycle* of our OWN RunPod GPU pod (the
 * one serving Qwen via llama.cpp) purely to control **GPU billing** — a stopped
 * pod costs nothing to run. It performs NO load generation, opens NO connection
 * to any target, and knows nothing about campaigns. It is a cost/ops control,
 * gated by `assistant:manage` and audited on every start/stop.
 *
 * We use RunPod **stop / resume** (never terminate / create): the pod id and its
 * proxy URL (`https://<podId>-<port>.proxy.runpod.net`) stay stable across a
 * stop/resume cycle, so the assistant endpoint never has to be reconfigured.
 *
 * Fail-soft: no RUNPOD_API_KEY / RUNPOD_POD_ID → `configured:false` and the
 * routes report an "unmanaged" pod instead of failing.
 */

export interface RunpodConfig {
  /** RunPod API key (GraphQL). */
  apiKey?: string;
  /** The pod id to control (stable across stop/resume). */
  podId?: string;
  /** The port llama.cpp listens on inside the pod (proxy subdomain). */
  port: number;
  /** GraphQL endpoint. */
  apiUrl: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

export type PodState = 'RUNNING' | 'STARTING' | 'STOPPED' | 'UNKNOWN';

export interface PodStatus {
  /** Whether pod power control is configured (api key + pod id present). */
  configured: boolean;
  state: PodState;
  /** Seconds the pod has been up, when running. */
  uptimeSec?: number;
  /** Last error talking to RunPod, if any (never leaks the key). */
  error?: string;
}

const num = (v: string | undefined, dflt: number): number =>
  v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt;

/** Reads the RunPod control configuration from the environment. */
export function runpodConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RunpodConfig {
  return {
    apiKey: env.RUNPOD_API_KEY?.trim() || undefined,
    podId: env.RUNPOD_POD_ID?.trim() || undefined,
    port: num(env.RUNPOD_POD_PORT, 8080),
    apiUrl: env.RUNPOD_API_URL?.trim() || 'https://api.runpod.io/graphql',
    timeoutMs: num(env.RUNPOD_TIMEOUT_MS, 20000),
  };
}

/** True when both an API key and a pod id are present. */
export function runpodConfigured(cfg: RunpodConfig): boolean {
  return (
    typeof cfg.apiKey === 'string' &&
    cfg.apiKey.length > 0 &&
    typeof cfg.podId === 'string' &&
    cfg.podId.length > 0
  );
}

/**
 * The OpenAI-compatible endpoint the assistant should call when this pod is up.
 * Stable across stop/resume because it is keyed on the (immutable) pod id.
 * Returns undefined when no pod id is configured.
 */
export function podProxyEndpoint(cfg: RunpodConfig): string | undefined {
  if (!cfg.podId) return undefined;
  return `https://${cfg.podId}-${cfg.port}.proxy.runpod.net/v1`;
}

interface PodQueryResult {
  data?: {
    pod?: {
      id?: string;
      desiredStatus?: string;
      runtime?: { uptimeInSeconds?: number } | null;
    } | null;
    podResume?: { id?: string; desiredStatus?: string } | null;
    podStop?: { id?: string; desiredStatus?: string } | null;
  };
  errors?: { message?: string }[];
}

/** Bounded POST to the RunPod GraphQL API. Throws on transport/GraphQL error. */
async function graphql(cfg: RunpodConfig, query: string): Promise<PodQueryResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    // Key passed as query param (RunPod's documented form) AND as a Bearer
    // header for forward-compatibility. Server-side only; never logged.
    const url = `${cfg.apiUrl}?api_key=${encodeURIComponent(cfg.apiKey ?? '')}`;
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey ?? ''}`,
      },
      body: JSON.stringify({ query }),
    });
    const body = (await res.json().catch(() => ({}))) as PodQueryResult;
    if (!res.ok) throw new Error(`runpod http ${res.status}`);
    if (body.errors?.length) throw new Error(body.errors[0]?.message || 'runpod graphql error');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Maps RunPod's `desiredStatus` + runtime into our simple lifecycle state. */
function deriveState(desiredStatus: string | undefined, hasRuntime: boolean): PodState {
  if (desiredStatus === 'RUNNING') return hasRuntime ? 'RUNNING' : 'STARTING';
  if (desiredStatus === 'EXITED' || desiredStatus === 'STOPPED' || desiredStatus === 'TERMINATED') {
    return 'STOPPED';
  }
  return desiredStatus ? 'UNKNOWN' : 'UNKNOWN';
}

/** Current lifecycle state of the configured pod. Fail-soft on error. */
export async function podStatus(cfg: RunpodConfig): Promise<PodStatus> {
  if (!runpodConfigured(cfg)) return { configured: false, state: 'UNKNOWN' };
  try {
    const q = `query { pod(input:{podId:"${cfg.podId}"}) { id desiredStatus runtime { uptimeInSeconds } } }`;
    const r = await graphql(cfg, q);
    const pod = r.data?.pod;
    if (!pod) return { configured: true, state: 'UNKNOWN', error: 'pod not found' };
    const runtime = pod.runtime ?? null;
    return {
      configured: true,
      state: deriveState(pod.desiredStatus, runtime != null),
      uptimeSec: runtime?.uptimeInSeconds,
    };
  } catch (err) {
    return {
      configured: true,
      state: 'UNKNOWN',
      error: err instanceof Error ? err.message : 'error',
    };
  }
}

/** Resume (power on) the pod. Returns the resulting state. */
export async function podResume(cfg: RunpodConfig): Promise<PodStatus> {
  if (!runpodConfigured(cfg)) return { configured: false, state: 'UNKNOWN' };
  const q = `mutation { podResume(input:{podId:"${cfg.podId}", gpuCount:1}) { id desiredStatus } }`;
  const r = await graphql(cfg, q);
  return { configured: true, state: deriveState(r.data?.podResume?.desiredStatus, false) };
}

/** Stop (power off) the pod — frees the GPU billing. Returns the resulting state. */
export async function podStop(cfg: RunpodConfig): Promise<PodStatus> {
  if (!runpodConfigured(cfg)) return { configured: false, state: 'UNKNOWN' };
  const q = `mutation { podStop(input:{podId:"${cfg.podId}"}) { id desiredStatus } }`;
  const r = await graphql(cfg, q);
  return { configured: true, state: deriveState(r.data?.podStop?.desiredStatus, false) };
}
