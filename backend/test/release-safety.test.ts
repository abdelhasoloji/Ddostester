import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/agents/proc.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// Every deploy command is intercepted: no git mutation, service operation or network deployment.
describe('release safety', () => {
  it('refuses a dirty checkout before attempting build or promotion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-test-'));
    dirs.push(dir);
    await mkdir(join(dir, 'bin'));
    await writeFile(
      join(dir, 'bin/git'),
      '#!/bin/sh\nif [ "$1" = status ]; then echo " M local-work"; else exit 99; fi\n',
      { mode: 0o755 },
    );
    const child = spawn(
      'bash',
      [fileURLToPath(new URL('../../deploy/update.sh', import.meta.url))],
      {
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
      },
    );
    let text = '';
    child.stderr.on('data', (d) => (text += d.toString()));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(1);
    expect(text).toMatch(/checkout contains local work/);
  });
  it('rejects a healthy server that serves the wrong build', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manifest-test-'));
    dirs.push(dir);
    const file = join(dir, 'manifest.json');
    await writeFile(
      file,
      JSON.stringify({ build: { commit: 'expected', build: '42' }, assets: {} }),
    );
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: { commit: 'old', build: '41' }, ready: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const result = await runProcess(
        process.execPath,
        [
          fileURLToPath(new URL('../../scripts/verify-release.mjs', import.meta.url)),
          file,
          `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        ],
        { timeoutMs: 3000 },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/does not match expected release/);
      expect(JSON.parse(await readFile(file, 'utf8')).build.commit).toBe('expected');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
