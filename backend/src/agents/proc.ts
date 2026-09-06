import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs an external binary, captures stdout/stderr, handles abort via killSignal. */
export function runProcess(
  bin: string,
  args: string[],
  opts: { input?: string; killSignal?: AbortSignal } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    const onAbort = () => p.kill('SIGTERM');
    opts.killSignal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      opts.killSignal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) {
      p.stdin.write(opts.input);
      p.stdin.end();
    }
  });
}

/** True if `bin <versionArg>` exits successfully (tool present). */
export function binaryAvailable(bin: string, versionArg = '--version'): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(bin, [versionArg], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

/** Runs `fn` with a fresh temp dir (shieldtest-<prefix>-*), always cleaned up. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `shieldtest-${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
