import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runpodConfigFromEnv,
  runpodConfigured,
  podProxyEndpoint,
  podStatus,
  podResume,
  podStop,
  type RunpodConfig,
} from '../src/modules/assistant/runpod.js';

const CFG: RunpodConfig = {
  apiKey: 'k-secret',
  podId: 'pod123',
  port: 8080,
  apiUrl: 'https://api.runpod.io/graphql',
  timeoutMs: 5000,
};

function mockGraphql(body: unknown, ok = true): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response);
}

afterEach(() => vi.restoreAllMocks());

describe('runpod config', () => {
  it('reads env with defaults', () => {
    const cfg = runpodConfigFromEnv({
      RUNPOD_API_KEY: 'k',
      RUNPOD_POD_ID: 'p',
    } as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('k');
    expect(cfg.podId).toBe('p');
    expect(cfg.port).toBe(8080);
    expect(cfg.apiUrl).toContain('runpod.io');
  });

  it('is unconfigured without both key and pod id', () => {
    expect(runpodConfigured(runpodConfigFromEnv({} as NodeJS.ProcessEnv))).toBe(false);
    expect(
      runpodConfigured(runpodConfigFromEnv({ RUNPOD_API_KEY: 'k' } as NodeJS.ProcessEnv)),
    ).toBe(false);
    expect(runpodConfigured(CFG)).toBe(true);
  });

  it('derives a stable proxy endpoint from the pod id', () => {
    expect(podProxyEndpoint(CFG)).toBe('https://pod123-8080.proxy.runpod.net/v1');
    expect(podProxyEndpoint({ ...CFG, podId: undefined })).toBeUndefined();
  });
});

describe('podStatus mapping', () => {
  it('RUNNING with runtime → RUNNING (+uptime)', async () => {
    mockGraphql({ data: { pod: { desiredStatus: 'RUNNING', runtime: { uptimeInSeconds: 120 } } } });
    const s = await podStatus(CFG);
    expect(s).toMatchObject({ configured: true, state: 'RUNNING', uptimeSec: 120 });
  });

  it('RUNNING without runtime → STARTING', async () => {
    mockGraphql({ data: { pod: { desiredStatus: 'RUNNING', runtime: null } } });
    expect((await podStatus(CFG)).state).toBe('STARTING');
  });

  it('EXITED → STOPPED', async () => {
    mockGraphql({ data: { pod: { desiredStatus: 'EXITED', runtime: null } } });
    expect((await podStatus(CFG)).state).toBe('STOPPED');
  });

  it('missing pod → UNKNOWN with error', async () => {
    mockGraphql({ data: { pod: null } });
    const s = await podStatus(CFG);
    expect(s.state).toBe('UNKNOWN');
    expect(s.error).toBeTruthy();
  });

  it('fail-soft on transport error (never throws)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const s = await podStatus(CFG);
    expect(s).toMatchObject({ configured: true, state: 'UNKNOWN' });
    expect(s.error).toContain('network');
  });

  it('unmanaged config → configured:false, no call', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const s = await podStatus({ ...CFG, podId: undefined });
    expect(s.configured).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never puts the api key in the request body', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { pod: { desiredStatus: 'RUNNING', runtime: { uptimeInSeconds: 1 } } },
      }),
    } as Response);
    await podStatus(CFG);
    const body = String((spy.mock.calls[0]?.[1] as RequestInit)?.body ?? '');
    expect(body).not.toContain('k-secret');
    expect(body).toContain('pod123');
  });
});

describe('pod power mutations', () => {
  it('resume returns STARTING (no runtime yet)', async () => {
    mockGraphql({ data: { podResume: { id: 'pod123', desiredStatus: 'RUNNING' } } });
    expect((await podResume(CFG)).state).toBe('STARTING');
  });

  it('stop returns STOPPED', async () => {
    mockGraphql({ data: { podStop: { id: 'pod123', desiredStatus: 'EXITED' } } });
    expect((await podStop(CFG)).state).toBe('STOPPED');
  });

  it('surfaces graphql errors (throws for the route to 502)', async () => {
    mockGraphql({ errors: [{ message: 'quota exceeded' }] });
    await expect(podResume(CFG)).rejects.toThrow('quota');
  });
});
