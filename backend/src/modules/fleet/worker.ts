import type { FleetAssignment } from './contract.js';

export interface WorkerOutcome {
  state: 'SUCCEEDED' | 'STOPPED' | 'FAILED';
  reason: string;
  [key: string]: unknown;
}

/**
 * What the resident worker needs from its transport. Kept as a port so the loop
 * can be tested without TLS, a coordinator or a database.
 */
export interface WorkerControl {
  /** The shard planned for this certificate identity, or null when there is none. */
  poll(): Promise<FleetAssignment | null>;
  /** Execute exactly one assignment. Must honour the signal and never retry load. */
  execute(assignment: FleetAssignment, signal: AbortSignal): Promise<WorkerOutcome>;
  /** Report the outcome. A failure is tolerated: the lease expires instead. */
  report(assignment: FleetAssignment, outcome: WorkerOutcome): Promise<boolean>;
}

export interface WorkerOptions {
  /** Idle poll interval. */
  pollMs: number;
  signal: AbortSignal;
  /** Consecutive poll failures tolerated before the worker stops (default 5). */
  maxPollFailures?: number;
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface WorkerRun {
  iterations: number;
  executed: number;
  reported: number;
  pollFailures: number;
  stoppedBy: 'signal' | 'poll-failures' | null;
}

/** Abort-aware sleep: a stop request must not wait out the poll interval. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Resident worker loop (M2.2): poll for work, execute one shard, report, repeat.
 *
 * Failure policy, chosen to stay fail-closed:
 *  - a transient poll failure is retried, and only a run of `maxPollFailures`
 *    consecutive failures stops the worker (so a coordinator restart does not
 *    kill every site);
 *  - an execution failure is reported as FAILED, never retried — a second attempt
 *    would multiply the budget;
 *  - a failed report is tolerated: the shard's lease expires and the coordinator
 *    records it as LOST.
 */
export async function runWorkerLoop(
  control: WorkerControl,
  options: WorkerOptions,
): Promise<WorkerRun> {
  if (!Number.isInteger(options.pollMs) || options.pollMs < 1)
    throw new Error('Invalid poll interval');
  const maxPollFailures = options.maxPollFailures ?? 5;
  const { pollMs, signal, onEvent } = options;
  const run: WorkerRun = {
    iterations: 0,
    executed: 0,
    reported: 0,
    pollFailures: 0,
    stoppedBy: null,
  };
  while (!signal.aborted) {
    run.iterations++;
    let assignment: FleetAssignment | null;
    try {
      assignment = await control.poll();
      run.pollFailures = 0;
    } catch {
      run.pollFailures++;
      onEvent?.('worker.poll_failed', { failures: run.pollFailures });
      if (run.pollFailures >= maxPollFailures) {
        run.stoppedBy = 'poll-failures';
        break;
      }
      await sleep(pollMs, signal);
      continue;
    }
    if (!assignment) {
      await sleep(pollMs, signal);
      continue;
    }
    run.executed++;
    let outcome: WorkerOutcome;
    try {
      outcome = await control.execute(assignment, signal);
    } catch {
      outcome = { state: 'FAILED', reason: 'worker_execute_failed' };
      onEvent?.('worker.execute_failed', { runId: assignment.runId });
    }
    try {
      if (await control.report(assignment, outcome)) run.reported++;
      else onEvent?.('worker.report_refused', { runId: assignment.runId });
    } catch {
      onEvent?.('worker.report_failed', { runId: assignment.runId });
    }
  }
  if (!run.stoppedBy && signal.aborted) run.stoppedBy = 'signal';
  return run;
}
