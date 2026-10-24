import type { FleetProgress } from './progress.js';
import { performance } from 'node:perf_hooks';
import { FLEET_LIMITS, type HardCaps } from '../../config/limits.js';
import { BuiltinHttpAgent } from '../../agents/builtin.js';
import type { AttackAgent } from '../../agents/types.js';
import type { LoadTestResult } from '../../engine/types.js';
import { validateAssignment, validatePacketAssignment } from './contract.js';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startResourceMeasurement, type FleetResources } from './resources.js';
import { compileIoTProfile } from '../../engine/iot-profile.js';
import {
  packetCounterCommand,
  packetCounterSettleMs,
  readPacketCounter,
} from './packet-counter.js';

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
  // Une assignation paquet n'a ni débit de requêtes ni concurrence : elle suit
  // son propre schéma et son propre exécutant. La router avant la validation v1/v2,
  // sinon validateAssignment la rejette sur des champs qui n'existent pas.
  if (
    value &&
    typeof value === 'object' &&
    (value as { schema?: string }).schema === 'ddostester.fleet.assignment/v3'
  ) {
    const packet = validatePacketAssignment(value, {
      agentId: policy.agentId,
      allowedHosts: policy.allowedHosts,
      allowedPorts: policy.allowedPorts,
      maxPps: FLEET_LIMITS.maxPps,
      minDurationSec: FLEET_LIMITS.minDurationSec,
      maxDurationSec: FLEET_LIMITS.maxDurationSec,
      now: startedWall,
    });
    return runPacketAssignment(packet, signal);
  }
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

/** Exécute une assignation paquet et rend les paquets émis et reçus. */
async function runPacketAssignment(
  assignment: {
    agentId: string;
    campaignId: string;
    attemptId: string;
    port: number;
    pps: number;
    durationSec: number;
    target: string;
  },
  signal?: AbortSignal,
): Promise<{
  state: 'SUCCEEDED' | 'STOPPED' | 'FAILED';
  reason: string;
  generator?: LoadTestResult;
  resources?: FleetResources;
}> {
  // Le compteur de la cible est la seule preuve d'arrivée. Sans lecteur
  // configuré, la mission est refusée AVANT toute émission : envoyer du trafic
  // qu'on ne peut pas mesurer ne prouve rien.
  let command: string[] | null;
  let settleMs: number;
  try {
    command = packetCounterCommand();
    settleMs = packetCounterSettleMs();
  } catch (error) {
    return {
      state: 'FAILED',
      reason: error instanceof Error ? error.message : 'packet counter configuration invalid',
    };
  }
  if (!command) {
    return {
      state: 'FAILED',
      reason:
        'packet counter not configured (PACKET_COUNTER_CMD); refusing to emit unmeasured traffic',
    };
  }
  let before: number;
  try {
    before = await readPacketCounter(command);
  } catch (error) {
    return {
      state: 'FAILED',
      reason: `packet counter unavailable before emission: ${errorText(error)}`,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), 'packet-'));
  const file = join(dir, 'assignment.json');
  try {
    await writeFile(file, JSON.stringify(assignment), { mode: 0o600 });
    const script = process.env.PACKET_AGENT || '/app/scripts/fleet/packet-agent.mjs';
    const child = spawn('node', [script, file], {
      env: {
        ...process.env,
        PACKET_GENERATOR: process.env.PACKET_GENERATOR || '/usr/local/bin/drs-pktgen',
        PACKET_MAX_PPS: String(FLEET_LIMITS.maxPps),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      signal,
    });
    let out = '';
    const outcome: { failure: string | null } = { failure: null };
    let handed = false;
    // Le générateur est borné par sa durée ; ce garde-fou couvre un processus
    // qui ne rendrait jamais la main.
    const watchdog = setTimeout(
      () => {
        outcome.failure ??= 'packet agent exceeded its mission window';
        child.kill('SIGTERM');
      },
      (assignment.durationSec + 30) * 1000,
    );
    child.on('message', (message: unknown) => {
      if (handed) return;
      const event = (message as { event?: unknown } | null)?.event;
      if (event !== 'packet.emitted') return;
      handed = true;
      void (async () => {
        try {
          if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
          const after = await readPacketCounter(command);
          if (after < before)
            throw new Error(`target counter went backwards (${before} then ${after})`);
          if (!child.connected) throw new Error('packet agent exited before the count arrived');
          child.send({ event: 'packet.received', PACKET_RECEIVED: after - before });
        } catch (error) {
          outcome.failure = `packet counter unavailable after emission: ${errorText(error)}`;
          child.kill('SIGTERM');
        }
      })();
    });
    child.stdout!.on('data', (d: Buffer) => (out += d));
    child.stderr!.on('data', (d: Buffer) => (out += d));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    clearTimeout(watchdog);
    if (signal?.aborted) return { state: 'STOPPED', reason: 'cancelled' };
    if (outcome.failure) return { state: 'FAILED', reason: outcome.failure };
    let parsed: { packetsSent?: number; packetsReceived?: number | null; accepted?: boolean } = {};
    try {
      parsed = JSON.parse(out);
    } catch {
      return {
        state: 'FAILED',
        reason: `packet agent produced no result (exit ${code}): ${out.slice(0, 160)}`,
      };
    }
    if (code !== 0) return { state: 'FAILED', reason: `packet generator exited ${code}` };
    if (!parsed.accepted) {
      return {
        state: 'FAILED',
        reason: `packets received ${parsed.packetsReceived ?? 'unknown'} below 99 % of ${parsed.packetsSent ?? 0} sent`,
      };
    }
    return {
      state: 'SUCCEEDED',
      reason: `packet mission delivered (${parsed.packetsReceived} received)`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
