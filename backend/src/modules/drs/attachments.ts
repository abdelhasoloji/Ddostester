import type { CampaignRun } from '../campaigns/runner.js';
import type { BenchRun } from '../bench/model.js';
import { digest } from './reference.js';
export interface DrsAttachment {
  kind: 'campaign-run' | 'network-bench';
  sourceId: string;
  sourceHash: string;
  archivedAt: string;
  measurements: Record<string, unknown>;
  limitations: string[];
  source: unknown;
}
export function runAttachment(run: CampaignRun): DrsAttachment {
  return {
    kind: 'campaign-run',
    sourceId: run.runId,
    sourceHash: digest(run),
    archivedAt: new Date().toISOString(),
    measurements: {
      emitted_load: { value: run.generator.actualRps, unit: 'tps' },
      received_load: null,
      legitimate_transaction_success: null,
      probeAvailability: { available: run.probe.available, total: run.probe.samples },
      latency_during_test: run.probe.latencyMs,
      recovery_timestamp: null,
    },
    limitations: [
      'Generator counters measure emission, not received load',
      'HTTP probe availability is not proof of a functional user journey',
      'Full latency distributions, independent entry/origin evidence and recovery are not supplied by this legacy run',
      'A run attachment does not mark any official standard vector as passed',
    ],
    source: structuredClone(run),
  };
}
export function benchAttachment(run: BenchRun): DrsAttachment {
  return {
    kind: 'network-bench',
    sourceId: run.id,
    sourceHash: digest(run),
    archivedAt: new Date().toISOString(),
    measurements: {
      actual_received_load: {
        bps: run.verdict?.target?.avgBps ?? null,
        pps: run.verdict?.target?.avgPps ?? null,
      },
      injection_point: run.labTarget,
      declared_synthetic_factor: run.verdict?.amplificationFactor ?? null,
      kind: run.verdict?.kind ?? null,
    },
    limitations: [
      'Read-only isolated laboratory observation; no traffic dispatched',
      'No numeric amplification multiplier is applied to received measurements',
      'Internet source distribution and a real reflection chain are not demonstrated',
      'Functional service, latency distribution, independent measurement positions and calibration need separate evidence',
      'No perimeter or DRS score is inferred from this attachment',
    ],
    source: structuredClone(run),
  };
}
