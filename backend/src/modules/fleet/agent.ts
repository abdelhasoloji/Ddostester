import type { FleetProgress } from './progress.js';
import { performance } from 'node:perf_hooks';
import { FLEET_LIMITS, type HardCaps } from '../../config/limits.js';
import { BuiltinHttpAgent } from '../../agents/builtin.js';
import type { AttackAgent } from '../../agents/types.js';
import type { LoadTestResult } from '../../engine/types.js';
import { validateAssignment } from './contract.js';
import { startResourceMeasurement, type FleetResources } from './resources.js';
import { compileIoTProfile } from '../../engine/iot-profile.js';

export interface FleetAgentControl {
  renew(sequence: number, progress?: FleetProgress): Promise<{ leaseUntil: number } | null>;
}
/** One assignment, one process. Cancellation/lease loss always stops; never retries load. */
export async function runFleetAssignment(
  value: unknown,
  policy: { agentId: string; allowedHosts: string[]; allowedPorts: number[]; caps: HardCaps },
  control: FleetAgentControl,
  signal?: AbortSignal,
  engine: AttackAgent = new BuiltinHttpAgent(),
): Promise<{
  state: 'SUCCEEDED' | 'STOPPED' | 'FAILED';
  reason: string;
  generator?: LoadTestResult;
  resources?: FleetResources;
}> {
  const startedWall = Date.now();
  const startedMono = performance.now();
  const assignment = validateAssignment(value, { ...policy, now: startedWall });
  const resources = startResourceMeasurement();
  const now = () => startedWall + performance.now() - startedMono;
  const controller = new AbortController();
  let reason = 'completed';
  let leaseUntil = assignment.leaseUntil;
  let sequence = 0;
  let progress: FleetProgress | undefined;
  let leaseTimer: ReturnType<typeof setTimeout>;
  const stop = (why: string) => {
    if (!controller.signal.aborted) {
      reason = why;
      controller.abort();
    }
  };
  const arm = () => {
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(
      () => stop(leaseUntil >= assignment.deadline ? 'deadline' : 'lease_expired'),
      Math.max(0, Math.min(leaseUntil, assignment.deadline) - now()),
    );
  };
  const cancel = () => stop('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  arm();
  let renewal: Promise<void> | undefined;
  const tick = setInterval(() => {
    if (renewal || controller.signal.aborted) return;
    renewal = (async () => {
      try {
        const response = await Promise.race([
          control.renew(++sequence, progress),
          new Promise<null>((resolve) => {
            const t = setTimeout(() => resolve(null), FLEET_LIMITS.heartbeatMs);
            t.unref();
          }),
        ]);
        if (controller.signal.aborted) return;
        if (
          !response ||
          !Number.isSafeInteger(response.leaseUntil) ||
          response.leaseUntil <= now() ||
          response.leaseUntil > assignment.deadline ||
          response.leaseUntil - now() > FLEET_LIMITS.leaseMs
        ) {
          stop('control_lost');
          return;
        }
        leaseUntil = response.leaseUntil;
        arm();
      } catch {
        stop('control_lost');
      }
    })().finally(() => {
      renewal = undefined;
    });
  }, FLEET_LIMITS.heartbeatMs);
  try {
    if (controller.signal.aborted) return { state: 'STOPPED', reason };
    // Reserve bounded settlement time; generation must finish before the hard mission deadline.
    const remaining = Math.floor((assignment.deadline - now() - FLEET_LIMITS.stopGraceMs) / 1000);
    if (remaining < 1) return { state: 'STOPPED', reason: 'deadline' };
    const generator = await engine.run(
      {
        url: assignment.target,
        method: 'GET',
        ...(assignment.iotProfile
          ? {
              flow: compileIoTProfile(
                assignment.iotProfile,
                assignment.target,
                assignment.probeUrl!,
              ),
            }
          : {}),
        authorized: true,
        requestPermit: () => {
          if (now() >= Math.min(leaseUntil, assignment.deadline)) stop('lease_expired');
          return !controller.signal.aborted;
        },
        maxRps: assignment.maxRps,
        concurrency: assignment.concurrency,
        durationSec: Math.min(assignment.durationSec, remaining),
        headers: {
          'X-WEDOS-TEST': `${assignment.campaignId}:${assignment.runId}:${assignment.agentId}:${assignment.attemptId}`,
        },
      },
      policy.allowedHosts,
      controller.signal,
      (sample) => {
        progress = {
          sent: sample.sent,
          successful: sample.successful,
          failed: sample.failed,
          elapsedSec: sample.elapsedSec,
          actualRps: sample.actualRps,
        };
      },
    );
    return {
      state: controller.signal.aborted ? 'STOPPED' : generator.hardStopped ? 'FAILED' : 'SUCCEEDED',
      reason,
      generator,
      resources: await resources(),
    };
  } catch {
    return {
      state: controller.signal.aborted ? 'STOPPED' : 'FAILED',
      reason: controller.signal.aborted ? reason : 'engine_failed',
      resources: await resources(),
    };
  } finally {
    clearTimeout(leaseTimer!);
    clearInterval(tick);
    signal?.removeEventListener('abort', cancel);
  }
}
