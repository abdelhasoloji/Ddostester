import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
import { MemoryStore } from '../src/store/memory.js';
import { PostgresStore } from '../src/store/postgres.js';
import type { Store } from '../src/store/types.js';
import {
  hostProfile,
  infrastructureEvidence,
  makeRevision,
  qualification,
  qualificationGates,
  type InfrastructureEvidence,
} from '../src/modules/infrastructure/model.js';
import { INFRASTRUCTURE_LIMITS } from '../src/config/limits.js';
import { digest } from '../src/modules/drs/reference.js';

const profile = { siteId: 'site-a', name: 'Physical A' };
const host = makeRevision('host', 'host-a', hostProfile(profile), undefined, 'operator');
const evidence = (gate: InfrastructureEvidence['gate'], override = {}) =>
  makeRevision(
    'evidence',
    randomUUID(),
    infrastructureEvidence({
      hostId: host.id,
      profileHash: host.hash,
      gate,
      observedAt: new Date().toISOString(),
      outcome: 'pass',
      content: 'Sanitized operator receipt',
      ...override,
    }),
    undefined,
    'operator',
  );
it('preserves unknown specifications and refuses guessed types, invalid addresses and a shared interface', () => {
  expect(hostProfile(profile)).toMatchObject({
    architecture: null,
    cores: null,
    nicModel: null,
    publicAddresses: [],
  });
  for (const extra of [
    { shell: 'x' },
    { architecture: 'sparc' },
    { linkGbps: -1 },
    { memoryGiB: '1024' },
    { managementAddress: 'not-an-ip' },
    { publicAddresses: ['https://example.test'] },
    { managementInterface: 'eth0', dataInterface: 'eth0' },
  ])
    expect(() => hostProfile({ ...profile, ...extra })).toThrow();
  expect(
    hostProfile({ ...profile, publicAddresses: ['2001:db8::1'], managementAddress: '10.0.0.1' })
      .publicAddresses,
  ).toEqual(['2001:db8::1']);
});
it('binds the complete revision and maintains a reproducible hash chain', () => {
  const next = makeRevision(
    'host',
    host.id,
    hostProfile({ ...profile, os: 'Linux' }),
    host,
    'other',
  );
  expect(next).toMatchObject({ revision: 2, previousHash: host.hash, actor: 'other' });
  const { hash, ...rest } = next;
  expect(hash).toBe(digest(rest));
  expect(next.hash).not.toBe(host.hash);
});
it('requires two hosts and every gate, without turning attestations into physical qualification', () => {
  const second = makeRevision(
    'host',
    'host-b',
    hostProfile({ ...profile, name: 'Physical B' }),
    undefined,
    'operator',
  );
  const receipts = qualificationGates.flatMap((g) => [
    evidence(g),
    makeRevision(
      'evidence',
      randomUUID(),
      {
        ...evidence(g).payload,
        hostId: second.id,
        profileHash: second.hash,
      } as InfrastructureEvidence,
      undefined,
      'operator',
    ),
  ]);
  expect(qualification([host, second], receipts, [host.id, second.id])).toMatchObject({
    status: 'documented',
    hardwareQualified: false,
    executionAuthorized: false,
  });
  expect(qualification([host], receipts, [host.id]).status).toBe('incomplete');
  expect(qualification([host, second], receipts.slice(1), [host.id, second.id]).status).toBe(
    'incomplete',
  );
});
it('keeps stale, expired, failing and conflicting evidence incomplete', () => {
  const stale = evidence('architecture', { profileHash: 'a'.repeat(64) });
  const expired = evidence('runtime', {
    observedAt: new Date(Date.now() - INFRASTRUCTURE_LIMITS.evidenceMaxAgeMs - 1000).toISOString(),
  });
  const failing = evidence('nic', { outcome: 'fail' });
  const timestamp = new Date().toISOString();
  const conflict = [
    evidence('clock', { observedAt: timestamp }),
    evidence('clock', { observedAt: timestamp, outcome: 'fail' }),
  ];
  const q = qualification([host], [stale, expired, failing, ...conflict], [host.id]);
  expect(q.selectedHosts[0].gates.map((g) => g.status)).toEqual([
    'stale-profile',
    'expired',
    'fail',
    'missing',
    'missing',
    'conflicting',
    'missing',
    'missing',
  ]);
});
it('selects the newest observation rather than a late submission of an old pass', () => {
  const older = evidence('nic', { observedAt: new Date(Date.now() - 2000).toISOString() });
  const newer = evidence('nic', { outcome: 'fail' });
  expect(
    qualification([host], [newer, older], [host.id]).selectedHosts[0].gates.find(
      (g) => g.gate === 'nic',
    )?.status,
  ).toBe('fail');
});
it('rejects absent, future or oversized evidence without network access', () => {
  for (const extra of [
    { content: '' },
    { content: 'x'.repeat(INFRASTRUCTURE_LIMITS.maxEvidenceChars + 1) },
    { gate: 'execute' },
    { observedAt: new Date(Date.now() + 600_000).toISOString() },
  ])
    expect(() => evidence('runtime', extra)).toThrow();
});

const pgUrl = process.env.DATABASE_URL_TEST;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !pgUrl)
  throw Error('Disposable DATABASE_URL_TEST required');
for (const backend of ['memory', 'postgres'] as const) {
  (backend === 'postgres' && !pgUrl ? describe.skip : describe)(
    `${backend} infrastructure API`,
    () => {
      let store: Store, app: Awaited<ReturnType<typeof buildApp>>['app'];
      let admin: { authorization: string }, viewer: { authorization: string };
      const id = 'host-' + randomUUID();
      const base = '/api/fleet/infrastructure';
      beforeAll(async () => {
        store = backend === 'memory' ? new MemoryStore() : new PostgresStore(pgUrl!);
        await store.init();
        ({ app } = await buildApp({
          store,
          logger: false,
          serveStatic: false,
          allowedTargets: ['127.0.0.1'],
          auth: initAuth({
            USER_MODE: 'team',
            AUTH_JWT_SECRET: 'isolated-infrastructure-fixture',
            AUTH_USERS: JSON.stringify([
              {
                email: 'abdelha@wedos',
                role: 'admin',
                passwordHash: hashPassword('admin-fixture-password'),
              },
              {
                email: 'view@wedos',
                role: 'viewer',
                passwordHash: hashPassword('viewer-fixture-password'),
              },
            ]),
          }),
        }));
        const login = async (email: string, password: string) => ({
          authorization:
            'Bearer ' +
            (
              await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: { email, password },
              })
            ).json().token,
        });
        admin = await login('abdelha@wedos', 'admin-fixture-password');
        viewer = await login('view@wedos', 'viewer-fixture-password');
      });
      afterAll(async () => {
        await app?.close();
        if (store instanceof PostgresStore) await store.close();
      });
      it('enforces reader/admin permissions and starts with no invented host inventory', async () => {
        const view = await app.inject({ url: base, headers: viewer });
        expect(view.statusCode).toBe(200);
        expect(view.json().qualification).toMatchObject({
          hardwareQualified: false,
          status: 'incomplete',
        });
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: base + '/hosts/' + id,
              headers: viewer,
              payload: { expectedRevision: 0, profile },
            })
          ).statusCode,
        ).toBe(403);
      });
      it('serializes concurrent edits, retains prior revisions and actor-bound hashes', async () => {
        const responses = await Promise.all(
          [1, 2].map(() =>
            app.inject({
              method: 'PUT',
              url: base + '/hosts/' + id,
              headers: admin,
              payload: { expectedRevision: 0, profile },
            }),
          ),
        );
        expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        const saved = responses.find((r) => r.statusCode === 200)!.json();
        expect(saved).toMatchObject({
          actor: 'abdelha@wedos',
          revision: 1,
          payload: { architecture: null },
        });
        const update = await app.inject({
          method: 'PUT',
          url: base + '/hosts/' + id,
          headers: admin,
          payload: { expectedRevision: 1, profile: { ...profile, os: 'Linux' } },
        });
        expect(update.json()).toMatchObject({ revision: 2, previousHash: saved.hash });
        const history = (
          await app.inject({ url: base + '/host/' + id + '/history', headers: viewer })
        ).json();
        expect(history.revisions).toHaveLength(2);
        expect(history.revisions[0].hash).toBe(saved.hash);
        expect(
          (await store.listAuditChain()).some(
            (a) =>
              a.actor === 'abdelha@wedos' &&
              a.detail?.includes('infrastructure.host') &&
              a.detail.includes(update.json().hash),
          ),
        ).toBe(true);
      });
      it('records failed evidence, rejects a stale profile and preserves all evidence after a host edit', async () => {
        const host = (await store.listInfrastructure('host')).find((h) => h.id === id)!;
        const payload = {
          hostId: id,
          profileHash: host.hash,
          gate: 'runtime',
          observedAt: new Date().toISOString(),
          outcome: 'fail',
          content: 'Runtime receipt failed',
        };
        expect(
          (
            await app.inject({
              method: 'POST',
              url: base + '/evidence',
              headers: admin,
              payload: { ...payload, profileHash: 'a'.repeat(64) },
            })
          ).statusCode,
        ).toBe(409);
        const saved = await app.inject({
          method: 'POST',
          url: base + '/evidence',
          headers: admin,
          payload,
        });
        expect(saved.statusCode).toBe(201);
        expect(saved.json().actor).toBe('abdelha@wedos');
        await app.inject({
          method: 'PUT',
          url: base + '/hosts/' + id,
          headers: admin,
          payload: { expectedRevision: 2, profile: { ...profile, os: 'New Linux' } },
        });
        const workspace = (
          await app.inject({ url: base + '?hosts=' + id, headers: viewer })
        ).json();
        expect(workspace.evidence.some((e: { id: string }) => e.id === saved.json().id)).toBe(true);
        expect(
          workspace.qualification.selectedHosts[0].gates.find(
            (g: { gate: string }) => g.gate === 'runtime',
          ).status,
        ).toBe('stale-profile');
      });
      it('rolls back a revision when audit append fails', async () => {
        const spy = vi.spyOn(store, 'transaction').mockImplementation(async (fn) => {
          const original =
            backend === 'memory'
              ? MemoryStore.prototype.transaction
              : PostgresStore.prototype.transaction;
          return original.call(store, async (tx: Store) => {
            const audit = vi.spyOn(tx, 'saveAudit').mockRejectedValue(Error('Audit unavailable'));
            try {
              return await fn(tx);
            } finally {
              audit.mockRestore();
            }
          });
        });
        try {
          expect(
            (
              await app.inject({
                method: 'PUT',
                url: base + '/hosts/rollback-' + id,
                headers: admin,
                payload: { expectedRevision: 0, profile },
              })
            ).statusCode,
          ).toBe(500);
        } finally {
          spy.mockRestore();
        }
        expect(
          (await store.listInfrastructure('host')).some((h) => h.id === 'rollback-' + id),
        ).toBe(false);
      });
      it('shows reference-based level-5 gaps without awarding a measured score', async () => {
        const result = (await app.inject({ url: base, headers: viewer })).json();
        expect(result.readiness.levels.map((l: { level: number }) => l.level)).toEqual([
          1, 2, 3, 4, 5,
        ]);
        expect(result.readiness.vectors.length).toBeGreaterThan(0);
        expect(
          result.readiness.vectors.every(
            (v: { fullPhysicalStatus: string }) => v.fullPhysicalStatus === 'not-qualified',
          ),
        ).toBe(true);
        expect(result.readiness.fullPhysicalVectorsQualified).toBe(0);
        expect(result.readiness).not.toHaveProperty('score');
        expect(result.readiness.catalogueHash).toMatch(/^[a-f0-9]{64}$/);
        expect((await app.inject({ url: base + '?hosts=a,a', headers: viewer })).statusCode).toBe(
          400,
        );
        expect((await app.inject({ url: base + '?hosts=a,b,c', headers: viewer })).statusCode).toBe(
          400,
        );
      });
    },
  );
}
