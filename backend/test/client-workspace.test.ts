import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { PostgresStore } from '../src/store/postgres.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
import { initialClients } from '../src/modules/infrastructure/clients.js';
const url = process.env.DATABASE_URL_TEST;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !url)
  throw Error('Disposable DATABASE_URL_TEST required');
for (const backend of ['memory', 'postgres'] as const) {
  (backend === 'postgres' && !url ? describe.skip : describe)(
    backend + ' fixed client workspaces',
    () => {
      const store = backend === 'memory' ? new MemoryStore() : new PostgresStore(url!);
      let app: Awaited<ReturnType<typeof buildApp>>['app'],
        admin: { authorization: string },
        viewer: { authorization: string };
      const base = '/api/workspace/clients',
        profile = initialClients[0].profile;
      let previous = 0;
      beforeAll(async () => {
        await store.init();
        previous =
          (await store.listInfrastructure('client')).find((c) => c.id === 'bank-cz')?.revision ?? 0;
        ({ app } = await buildApp({
          store,
          logger: false,
          serveStatic: false,
          allowedTargets: ['127.0.0.1'],
          auth: initAuth({
            USER_MODE: 'team',
            AUTH_JWT_SECRET: 'isolated-client-workspace-fixture',
            AUTH_USERS: JSON.stringify([
              {
                email: 'abdelha@wedos',
                role: 'admin',
                passwordHash: hashPassword('owner-password'),
              },
              {
                email: 'viewer@wedos',
                role: 'viewer',
                passwordHash: hashPassword('viewer-password'),
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
        admin = await login('abdelha@wedos', 'owner-password');
        viewer = await login('viewer@wedos', 'viewer-password');
      });
      afterAll(async () => {
        await app?.close();
        if (store instanceof PostgresStore) await store.close();
      });
      it('lists exactly three authorized clients without granting URL permission, creating targets or inventing scores', async () => {
        const before = await store.listInfrastructure('client');
        const campaignsBefore = await store.listCampaigns();
        const result = (await app.inject({ url: base, headers: viewer })).json();
        expect(result.clients.map((c: { id: string }) => c.id)).toEqual([
          'bank-cz',
          'enisa-preprod',
          'test-vps',
        ]);
        expect(
          result.clients.every(
            (c: { status: string; measuredScore: null }) =>
              c.status === 'authorized' && c.measuredScore === null,
          ),
        ).toBe(true);
        expect(result.clients[1].profile.reference).toBe('');
        expect(result.pilot).toEqual({ sites: 2, independentProbe: 1, capacityQualified: false });
        expect(await store.listInfrastructure('client')).toEqual(before);
        expect(await store.listCampaigns()).toEqual(campaignsBefore);
      });
      it('rejects a fourth client, a renamed identity and unauthorized edits', async () => {
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: base + '/other',
              headers: admin,
              payload: { expectedRevision: 0, profile },
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: base + '/bank-cz',
              headers: admin,
              payload: {
                expectedRevision: previous,
                profile: { ...profile, name: 'Another client' },
              },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: base + '/bank-cz',
              headers: viewer,
              payload: { expectedRevision: previous, profile },
            })
          ).statusCode,
        ).toBe(403);
      });
      it('atomically saves scope with history, optimistic conflict control and actor-bound audit', async () => {
        const payload = {
          expectedRevision: previous,
          profile: {
            ...profile,
            owner: 'Assessment owner',
            scope: 'Preproduction login journey',
            notes: 'No execution from this page',
          },
        };
        const result = await Promise.all(
          [1, 2].map(() =>
            app.inject({ method: 'PUT', url: base + '/bank-cz', headers: admin, payload }),
          ),
        );
        expect(result.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        const saved = result.find((r) => r.statusCode === 200)!.json();
        expect(saved.revision).toBe(previous + 1);
        const history = (
          await app.inject({ url: base + '/bank-cz/history', headers: viewer })
        ).json().revisions;
        expect(history.at(-1)).toMatchObject({
          actor: 'abdelha@wedos',
          hash: saved.hash,
          payload: { scope: payload.profile.scope },
        });
        expect(
          (await store.listAuditChain()).some(
            (a) => a.detail?.includes('workspace.client id=bank-cz') && a.actor === 'abdelha@wedos',
          ),
        ).toBe(true);
      });
    },
  );
}
