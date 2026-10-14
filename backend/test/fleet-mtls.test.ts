import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Agent, fetch } from 'undici';
import { X509Certificate } from 'node:crypto';
import { buildFleetServer } from '../src/modules/fleet/server.js';
import type { FleetCoordinator } from '../src/modules/fleet/coordinator.js';

it('refuses malformed or excessive revocation configuration before opening TLS', () => {
  const coordinator = {} as FleetCoordinator;
  const tls = { key: Buffer.alloc(0), cert: Buffer.alloc(0), ca: Buffer.alloc(0) };
  for (const fingerprints of [['short'], ['g'.repeat(64)], Array(129).fill('a'.repeat(64))]) {
    expect(() => buildFleetServer(coordinator, tls, ['one'], fingerprints)).toThrow(
      'Invalid revoked certificate fingerprints',
    );
  }
});

describe('real TLS agent authentication (loopback only)', () => {
  let dir: string;
  let origin: string;
  let app: ReturnType<typeof buildFleetServer>;
  const clients: Agent[] = [];
  const claim = vi.fn(async () => null);
  const openssl = (args: string[]) => {
    const result = spawnSync('openssl', args, { cwd: dir, timeout: 10000, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('Ephemeral test certificate generation failed');
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ddostester-fleet-tls-'));
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-days',
      '1',
      '-subj',
      '/CN=Fixture CA',
    ]);
    await writeFile(
      join(dir, 'server.ext'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
    );
    for (const name of ['server', 'one', 'one-renewed', 'unregistered']) {
      openssl([
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        name + '.key',
        '-out',
        name + '.csr',
        '-subj',
        '/CN=' + (name === 'one-renewed' ? 'one' : name),
      ]);
      openssl([
        'x509',
        '-req',
        '-in',
        name + '.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        name + '.crt',
        '-days',
        '1',
        ...(name === 'server' ? ['-extfile', 'server.ext'] : []),
      ]);
    }
    app = buildFleetServer(
      { claim } as unknown as FleetCoordinator,
      {
        key: await readFile(join(dir, 'server.key')),
        cert: await readFile(join(dir, 'server.crt')),
        ca: await readFile(join(dir, 'ca.crt')),
      },
      ['one'],
    );
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 20000);
  afterAll(async () => {
    for (const client of clients) await client.destroy();
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const client = async (name?: string) => {
    const connect = {
      ca: await readFile(join(dir, 'ca.crt')),
      ...(name
        ? {
            key: await readFile(join(dir, name + '.key')),
            cert: await readFile(join(dir, name + '.crt')),
          }
        : {}),
    };
    const agent = new Agent({ connect });
    clients.push(agent);
    return agent;
  };
  it('rejects the old leaf while accepting a renewed certificate with the same identity', async () => {
    const fingerprint = new X509Certificate(
      await readFile(join(dir, 'one.crt')),
    ).fingerprint256.replaceAll(':', '');
    const rotatedClaim = vi.fn(async () => null);
    const rotated = buildFleetServer(
      { claim: rotatedClaim } as unknown as FleetCoordinator,
      {
        key: await readFile(join(dir, 'server.key')),
        cert: await readFile(join(dir, 'server.crt')),
        ca: await readFile(join(dir, 'ca.crt')),
      },
      ['one'],
      [fingerprint],
    );
    try {
      const endpoint = await rotated.listen({ host: '127.0.0.1', port: 0 });
      for (const [name, expected] of [
        ['one', 403],
        ['one-renewed', 200],
      ] as const) {
        const response = await fetch(endpoint + '/internal/fleet/claim', {
          dispatcher: await client(name),
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: 'run' }),
          signal: AbortSignal.timeout(2000),
        });
        expect(response.status).toBe(expected);
        await response.arrayBuffer();
      }
      expect(rotatedClaim).toHaveBeenCalledTimes(1);
    } finally {
      await rotated.close();
    }
  });
  it('refuses TLS clients without a certificate before coordination', async () => {
    await expect(
      fetch(origin + '/internal/fleet/claim', {
        dispatcher: await client(),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run' }),
        signal: AbortSignal.timeout(2000),
      }),
    ).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled();
  });
  it('refuses a CA-signed but unregistered agent', async () => {
    const response = await fetch(origin + '/internal/fleet/claim', {
      dispatcher: await client('unregistered'),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run' }),
    });
    expect(response.status).toBe(403);
    await response.body?.cancel();
    expect(claim).not.toHaveBeenCalled();
  });
  it('binds claims to the certificate identity', async () => {
    const response = await fetch(origin + '/internal/fleet/claim', {
      dispatcher: await client('one'),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run' }),
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(claim).toHaveBeenCalledWith('run', 'one');
  });
});
