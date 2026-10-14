import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRecon } from '../src/modules/recon/fetch.js';
import { readBoundedBody } from '../src/util/http-body.js';
import { Probe, KillSwitch } from '../src/modules/probe/probe.js';
import { runProcess } from '../src/agents/proc.js';
import { MemoryStore } from '../src/store/memory.js';
import { auditedStore, mutationActor } from '../src/store/audited.js';
import { createCampaign, approveCampaign } from '../src/modules/campaigns/service.js';
import { buildApp } from '../src/app.js';
import { initAuth } from '../src/auth/guard.js';
import { signJwt } from '../src/auth/jwt.js';
import { hashPassword } from '../src/auth/passwords.js';
import { kills } from '../src/runtime/kills.js';

const input = {
  name: 'regression',
  target: 'http://target.test/',
  probeUrl: 'http://probe.test/',
  vector: 'http-get' as const,
  maxRps: 100,
  concurrency: 2,
  maxDurationSec: 2,
  authorized: true,
  createdBy: 'author@test',
};
const reconFlags = {
  enginesAvailable: 1,
  capsConfigured: true,
  protectionConfigured: false,
  labRunnerConfigured: false,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('destination and response budgets', () => {
  it('rejects an unallowlisted probe and unsupported protocols before transport', async () => {
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    await expect(
      runRecon(input.target, input.probeUrl, ['target.test'], reconFlags),
    ).rejects.toThrow(/allowlist/);
    await expect(
      runRecon('ftp://target.test/', input.probeUrl, ['target.test', 'probe.test'], reconFlags),
    ).rejects.toThrow(/HTTP/);
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not follow recon redirects', async () => {
    const transport = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(null, { status: 302, headers: { location: 'http://outside.test/' } }),
      );
    vi.stubGlobal('fetch', transport);
    await runRecon(input.target, input.target, ['target.test'], reconFlags);
    expect(transport).toHaveBeenCalledTimes(8);
    for (const [, opts] of transport.mock.calls) expect(opts.redirect).toBe('manual');
  });
  it('cancels an oversized response while streaming instead of buffering it', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4));
        c.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    await expect(readBoundedBody(body, 5)).rejects.toThrow(/byte budget/);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('probe safety remains independent', () => {
  it('kills unavailable probes despite a succeeding generator', async () => {
    const kill = new KillSwitch();
    const probe = new Probe(input.probeUrl, kill, 100, 100, { autoKillUnavailableMs: 10 });
    probe.watchGenerator(() => true);
    const sample = (
      probe as unknown as { evaluateAutoKill(v: unknown): void }
    ).evaluateAutoKill.bind(probe);
    sample({ at: 100, ok: false, status: 503, latencyMs: 50 });
    sample({ at: 120, ok: false, status: 503, latencyMs: 50 });
    expect(kill.reason).toBe('KILLED_AUTO');
    await probe.dispatcher.destroy();
  });
});

describe('process supervisor (inert fixtures only)', () => {
  it('does not spawn an already cancelled process', async () => {
    const signal = AbortSignal.abort();
    await expect(
      runProcess(process.execPath, ['-e', "throw new Error('must never run')"], {
        killSignal: signal,
      }),
    ).rejects.toThrow(/before spawn/);
  });
  it('forces termination of a fixture ignoring SIGTERM', async () => {
    const started = Date.now();
    const result = await runProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      { timeoutMs: 200, graceMs: 100 },
    );
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('caps captured output and terminates the writer', async () => {
    await expect(
      runProcess(
        process.execPath,
        ['-e', "setInterval(()=>process.stdout.write('x'.repeat(10000)),1)"],
        { outputLimit: 100, timeoutMs: 1000, graceMs: 20 },
      ),
    ).rejects.toThrow(/byte budget/);
  });
});

describe('transactional mutation receipt', () => {
  it('rolls back business state if its atomic audit cannot be persisted', async () => {
    const base = new MemoryStore();
    const c = createCampaign(input, ['target.test', 'probe.test']);
    vi.spyOn(base, 'saveAudit').mockRejectedValue(new Error('audit unavailable'));
    await expect(auditedStore(base).saveCampaign(c)).rejects.toThrow(/audit unavailable/);
    expect(await base.getCampaign(c.id)).toBeUndefined();
  });
  it('nested user operations roll back with their enclosing transaction', async () => {
    const store = new MemoryStore();
    await expect(
      store.transaction(async (tx) => {
        await tx.transactionUsers(async (users) => {
          await users.saveUser({
            email: 'nested@test',
            role: 'viewer',
            passwordHash: hashPassword('fixture-password'),
          });
        });
        throw new Error('abort transaction');
      }),
    ).rejects.toThrow('abort transaction');
    expect(await store.getUser('nested@test')).toBeUndefined();
  });
  it('persists the caller identity in the same transaction as the mutation', async () => {
    const base = new MemoryStore();
    const c = createCampaign(input, ['target.test', 'probe.test']);
    await mutationActor.run('operator@test', () => auditedStore(base).saveCampaign(c));
    expect((await base.listAuditChain())[0]).toMatchObject({
      actor: 'operator@test',
      action: 'store.mutate',
    });
    expect(await base.getCampaign(c.id)).toBeDefined();
  });
});

describe('start revalidation and cleanup', () => {
  it('rejects old operational limits for team actors before touching a transport', async () => {
    const store = new MemoryStore();
    const c = approveCampaign(
      createCampaign(input, ['target.test', 'probe.test']),
      'ciso@test',
      'APPROVED',
    );
    await store.saveCampaign(c);
    const built = await buildApp({
      store,
      auth: initAuth({ USER_MODE: 'team' }),
      allowedTargets: ['target.test', 'probe.test'],
      logger: false,
      serveStatic: false,
    });
    await store.setLimits({ maxRps: 10, maxConcurrency: 2, maxDurationSec: 2 });
    await expect(built.runCampaign(c, 'scheduler')).rejects.toThrow(/cap|limit|RPS/i);
    expect(kills.get(c.id)).toBeUndefined();
    await built.app.close();
  });
  it('cleans the runtime reservation when preparing RUNNING fails', async () => {
    const store = new MemoryStore();
    const c = approveCampaign(
      createCampaign(input, ['target.test', 'probe.test']),
      'ciso@test',
      'APPROVED',
    );
    const built = await buildApp({
      store,
      auth: initAuth({ USER_MODE: 'team' }),
      allowedTargets: ['target.test', 'probe.test'],
      logger: false,
      serveStatic: false,
    });
    vi.spyOn(store, 'saveCampaign').mockRejectedValue(new Error('storage unavailable'));
    await expect(built.runCampaign(c, 'scheduler')).rejects.toThrow(/storage unavailable/);
    expect(kills.get(c.id)).toBeUndefined();
    await built.app.close();
  });
});

describe('browser read session', () => {
  it('uses an HttpOnly cookie for reads and refuses it for mutations or a session JWT in the URL', async () => {
    const store = new MemoryStore();
    await store.saveUser({
      email: 'viewer@test',
      role: 'viewer',
      passwordHash: hashPassword('valid-password'),
      status: 'active',
      tokenVersion: 0,
    });
    const auth = initAuth({ USER_MODE: 'team', AUTH_JWT_SECRET: 'testsecret' });
    const { app } = await buildApp({
      store,
      auth,
      allowedTargets: ['target.test'],
      logger: false,
      serveStatic: false,
    });
    const token = signJwt({ sub: 'viewer@test', role: 'viewer', ver: 0 }, auth.secret);
    const me = await app.inject({
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const raw = me.headers['set-cookie'] as string;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    const cookie = raw.split(';')[0];
    expect(
      (await app.inject({ url: '/api/reports/compliance', headers: { cookie } })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: `/api/reports/compliance?token=${token}` })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/campaigns',
          headers: { cookie },
          payload: input,
        })
      ).statusCode,
    ).toBe(401);
    await store.saveUser({ ...(await store.getUser('viewer@test'))!, tokenVersion: 1 });
    expect(
      (await app.inject({ url: '/api/reports/compliance', headers: { cookie } })).statusCode,
    ).toBe(401);
    await app.close();
  });
});
