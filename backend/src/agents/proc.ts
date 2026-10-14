import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IO_LIMITS } from '../config/limits.js';

const supervised = new Set<ChildProcess>();

export async function stopAllProcesses(): Promise<void> {
  const processes = [...supervised];
  if (!processes.length) return;
  for (const p of processes) signalProcess(p, 'SIGTERM');
  await new Promise<void>((resolve) => setTimeout(resolve, IO_LIMITS.processGraceMs));
  for (const p of processes) signalProcess(p, 'SIGKILL');
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export interface ProcessOptions {
  cwd?: string;
  input?: string;
  killSignal?: AbortSignal;
  timeoutMs?: number;
  graceMs?: number;
  outputLimit?: number;
}

/** Stop the whole POSIX process group, including helpers inheriting pipe handles. */
export function signalProcess(p: ChildProcess, signal: NodeJS.Signals): void {
  if (!p.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-p.pid, signal);
    else p.kill(signal);
  } catch {
    /* Already exited. */
  }
}

/** A supervisor always bounds lifetime; SIGTERM is followed by forced group termination. */
export function superviseProcess(p: ChildProcess, opts: ProcessOptions = {}): () => void {
  supervised.add(p);
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const terminate = () => {
    if (stopped) return;
    stopped = true;
    signalProcess(p, 'SIGTERM');
    escalation = setTimeout(
      () => signalProcess(p, 'SIGKILL'),
      opts.graceMs ?? IO_LIMITS.processGraceMs,
    );
  };
  const deadline = setTimeout(terminate, opts.timeoutMs ?? IO_LIMITS.processDeadlineMs);
  opts.killSignal?.addEventListener('abort', terminate, { once: true });
  if (opts.killSignal?.aborted) terminate();
  const cleanup = () => {
    supervised.delete(p);
    clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    opts.killSignal?.removeEventListener('abort', terminate);
    // A parent exiting voluntarily must not leave descendants behind.
    signalProcess(p, 'SIGKILL');
  };
  p.once('close', cleanup);
  p.once('error', cleanup);
  return terminate;
}

/** Captures bounded output; abort-before-spawn never starts a process. */
export function startProcess(
  bin: string,
  args: string[],
  opts: ProcessOptions = {},
): { result: Promise<ProcResult>; stop: () => void } {
  if (opts.killSignal?.aborted) throw new Error('Process cancelled before spawn');
  const p = spawn(bin, args, { cwd: opts.cwd, detached: process.platform !== 'win32' });
  const stop = superviseProcess(p, opts);
  const result = new Promise<ProcResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let overflow = false;
    const capture = (d: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += d.length;
      if (bytes > (opts.outputLimit ?? IO_LIMITS.processOutputBytes)) {
        overflow = true;
        stop();
        return;
      }
      if (stream === 'stdout') stdout += d.toString();
      else stderr += d.toString();
    };
    p.stdout.on('data', (d) => capture(d, 'stdout'));
    p.stderr.on('data', (d) => capture(d, 'stderr'));
    p.stdin.on('error', () => {});
    p.once('error', reject);
    p.once('close', (code) => {
      if (overflow) reject(new Error('Process output exceeds byte budget'));
      else resolve({ code, stdout, stderr });
    });
    p.stdin.end(opts.input);
  });
  return { result, stop };
}

export async function runProcess(
  bin: string,
  args: string[],
  opts: ProcessOptions = {},
): Promise<ProcResult> {
  return startProcess(bin, args, opts).result;
}

export async function binaryAvailable(
  bin: string,
  versionArg: string | readonly string[] = '--version',
): Promise<boolean> {
  try {
    return (
      (
        await runProcess(bin, typeof versionArg === 'string' ? [versionArg] : [...versionArg], {
          timeoutMs: IO_LIMITS.binaryCheckMs,
        })
      ).code === 0
    );
  } catch {
    return false;
  }
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `shieldtest-${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
