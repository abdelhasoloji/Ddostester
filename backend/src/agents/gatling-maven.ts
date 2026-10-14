import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import { IO_LIMITS } from '../config/limits.js';
import { AgentError, type PreparedLoadRun } from './types.js';
import { runProcess, startProcess } from './proc.js';

/** Compilation and a native-user readiness handshake, with no target traffic. */
export async function prepareMavenGatling(
  home: string,
  config: LoadTestConfig,
  hosts: string[],
  signal: AbortSignal | undefined,
  source: (measurement: string, control: string) => string,
  report: (directory: string, startedAt: string) => Promise<LoadTestResult>,
): Promise<PreparedLoadRun> {
  validateConfig(config, hosts);
  if (config.phases?.length)
    throw new AgentError('Gatling does not support multi-phase scenarios.');
  if (signal?.aborted) throw new AgentError('Gatling preparation cancelled.');
  const deadline = performance.now() + IO_LIMITS.agentPreparationMs;
  const directory = await mkdtemp(join(tmpdir(), 'shieldtest-gatling-prepared-'));
  let process: ReturnType<typeof startProcess> | undefined;
  let completion: Promise<void> | undefined;
  let exitCode: number | null | undefined;
  let processError: unknown;
  let disposed = false,
    used = false;
  let running = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const stopLoad = () => {
    if (!running) {
      process?.stop();
      return;
    }
    void writeFile(join(directory, 'control.stop'), 'stop').catch(() => process?.stop());
    stopTimer = setTimeout(() => process?.stop(), IO_LIMITS.processGraceMs);
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', stopLoad);
    clearTimeout(stopTimer);
    process?.stop();
    await completion;
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const pom = await readFile(join(home, 'pom.xml'), 'utf8');
    if (!pom.includes('<gatling.version>3.16.0</gatling.version>'))
      throw new AgentError('GATLING_HOME requires Gatling 3.16.0.');
    await mkdir(join(directory, 'sim'));
    await writeFile(
      join(directory, 'sim', 'ShieldTestSimulation.java'),
      source(join(directory, 'attempts.tsv'), join(directory, 'control')),
    );
    await writeFile(
      join(directory, 'pom.xml'),
      pom
        .replace('<build>', '<build><testSourceDirectory>sim</testSourceDirectory>')
        .replace(
          '<configuration>',
          '<configuration><resultsFolder>${project.basedir}/results</resultsFolder>',
        ),
    );
    const args = [
      join(home, 'mvnw'),
      '--offline',
      '--batch-mode',
      '-f',
      join(directory, 'pom.xml'),
    ];
    const compilation = await runProcess('sh', [...args, 'test-compile'], {
      cwd: home,
      killSignal: signal,
      timeoutMs: Math.max(1, deadline - performance.now()),
    });
    if (compilation.code !== 0) throw new AgentError('Gatling simulation compilation failed.');
    process = startProcess(
      'sh',
      [
        ...args,
        'gatling:test',
        '-Dgatling.simulationClass=ShieldTestSimulation',
        '-Dgatling.noReports=true',
      ],
      {
        cwd: home,
        timeoutMs: IO_LIMITS.agentPreparationMs + config.durationSec * 1000 + 15_000,
      },
    );
    completion = process.result.then(
      (result) => {
        exitCode = result.code;
      },
      (error) => {
        processError = error;
        exitCode = null;
      },
    );
    signal?.addEventListener('abort', stopLoad, { once: true });
    if (signal?.aborted) stopLoad();
    while ((await readFile(join(directory, 'control.ready'), 'utf8').catch(() => '')) !== 'ready') {
      if (signal?.aborted || performance.now() >= deadline || exitCode !== undefined)
        throw new AgentError('Gatling runtime did not become ready.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      async run() {
        if (used || disposed || signal?.aborted)
          throw new AgentError('Prepared Gatling run is unavailable.');
        used = true;
        validateConfig(config, hosts);
        running = true;
        const startedAt = new Date().toISOString();
        const runtimeDeadline = setTimeout(
          () => process?.stop(),
          config.durationSec * 1000 + 15_000,
        );
        try {
          await writeFile(join(directory, 'control.start'), 'start', { flag: 'wx' });
          await completion;
          if (processError || (exitCode !== 0 && !signal?.aborted))
            throw new AgentError('Gatling simulation execution failed.');
          return await report(directory, startedAt);
        } finally {
          clearTimeout(runtimeDeadline);
        }
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
