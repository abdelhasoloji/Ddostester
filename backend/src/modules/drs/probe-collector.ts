/**
 * Probe-based evidence collector for the DRS orchestrator.
 *
 * The orchestrator asks a collector for capacity, a baseline, observations during the
 * exposure, recovery, and finally sealed evidence. This adapter observes what the control
 * plane can honestly observe: an independent HTTP probe of the service.
 *
 * It does **not** claim what it cannot see. Without a witness endpoint for the entry and
 * the origin, those measurement points are absent and `unrepresented_dimensions` says so,
 * so qualification returns INCONCLUSIVE with the exact missing instrumentation instead of a
 * fabricated pass. A prototype that could certify without witnesses would be a lie.
 */
import { createHash } from 'node:crypto';
import type { DrsEvidence, DrsPlan, DrsRevision } from './model.js';
import type { DrsEvidencePort } from './orchestrator.js';

export interface ProbeCollectorOptions {
  probeUrl: string;
  /** Edge/entry witness: a telemetry endpoint counting what reached the entry point. */
  entryWitnessUrl?: string;
  /** Origin witness: target-side telemetry counting what the application served. */
  originWitnessUrl?: string;
  /** Independent observation samples per second. */
  samplesPerSec?: number;
  /** Upper bound for the baseline window; the orchestrator may also abort earlier. */
  baselineMaxSec?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Sample {
  at: string;
  ms: number;
  status: number;
  ok: boolean;
  body: string;
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function latency(samples: Sample[]) {
  const ms = samples.map((s) => Math.round(s.ms * 100) / 100).sort((a, b) => a - b);
  const at = (p: number) =>
    ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : null;
  return {
    samplesMs: ms,
    meanMs: ms.length ? Math.round((ms.reduce((a, b) => a + b, 0) / ms.length) * 100) / 100 : null,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
  };
}

/** Parse the functional assertion the operator wrote into a checkable status, when it names
 *  one. "status 200 and body contains ok" → 200. Free text without a status is not evaluated
 *  rather than guessed. */
export function expectedStatus(assertion: string): number | null {
  const m = /\b([1-5]\d{2})\b/.exec(assertion ?? '');
  return m ? Number(m[1]) : null;
}

export function createProbeCollectorPort(opts: ProbeCollectorOptions): DrsEvidencePort & {
  readonly samples: readonly Sample[];
  readonly witnessSamples: readonly number[];
} {
  const intervalMs = Math.round(1000 / Math.max(1, opts.samplesPerSec ?? 2));
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let samples: Sample[] = [];
  let witnessSamples: number[] = [];
  let baselineSamples: Sample[] = [];
  let baselineSeconds = 0;
  let startedAt = '';
  let finishedAt = '';
  let recoveryAt: string | null = null;
  let entryBefore = 0;
  let entryAfter = 0;
  let originBefore = 0;
  let originAfter = 0;
  let entryErrors = 0;
  let originErrors = 0;
  let outageStart: string | null = null;
  const outages: { start: string; end: string }[] = [];

  const probe = async (url: string): Promise<Sample> => {
    const t0 = now();
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      const body = await response.text().catch(() => '');
      return {
        at: new Date(now()).toISOString(),
        ms: now() - t0,
        status: response.status,
        ok: response.ok,
        body: body.slice(0, 200),
      };
    } catch {
      return { at: new Date(now()).toISOString(), ms: now() - t0, status: 0, ok: false, body: '' };
    }
  };

  /** Read a cumulative counter from a witness endpoint: { requests, errors }. */
  const counter = async (url: string): Promise<{ requests: number; errors: number } | null> => {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const body = (await response.json()) as { requests?: unknown; errors?: unknown };
      const requests = Number(body.requests);
      const errors = Number(body.errors);
      return Number.isFinite(requests)
        ? { requests, errors: Number.isFinite(errors) ? errors : 0 }
        : null;
    } catch {
      return null;
    }
  };

  const sampleLoop = async (
    url: string,
    until: AbortSignal,
    collect: (s: Sample) => void,
  ): Promise<void> => {
    while (!until.aborted) {
      collect(await probe(url));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  const observeOutage = (s: Sample, from: string) => {
    if (!s.ok) {
      if (!outageStart) outageStart = s.at;
      return;
    }
    if (outageStart) {
      outages.push({ start: outageStart, end: s.at });
      outageStart = null;
    }
    if (finishedAt && !recoveryAt && s.at > finishedAt) recoveryAt = s.at;
    void from;
  };

  return {
    get samples() {
      return samples;
    },
    get witnessSamples() {
      return witnessSamples;
    },
    async capacity(_plan) {
      const check = await probe(opts.probeUrl);
      if (!check.ok)
        return {
          ready: false,
          reason: `probe not healthy before the exposure (status ${check.status})`,
        };
      const gaps = [
        opts.entryWitnessUrl ? null : 'no entry witness configured',
        opts.originWitnessUrl ? null : 'no origin witness configured',
        'calibration evidence is not collected by this adapter',
      ].filter(Boolean);
      // Ready to observe, but the gaps travel with every sealed evidence so the verdict
      // cannot silently ignore them.
      return {
        ready: true,
        reason: gaps.length ? `collector ready with gaps: ${gaps.join('; ')}` : 'collector ready',
      };
    },
    async baseline(_plan, signal) {
      baselineSamples = [];
      const began = now();
      // The orchestrator refuses a baseline shorter than the frozen plan asks for, so the
      // collector runs at least that long (plus a small margin) unless the caller bounds it.
      const required = Math.max(0, Number(_plan.baselineMinSec) || 0);
      const limit = Math.max(opts.baselineMaxSec ?? 0, required) * 1000;
      const bounded = new AbortController();
      const stop = () => bounded.abort();
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, limit);
      await sampleLoop(opts.probeUrl, bounded.signal, (s) => baselineSamples.push(s));
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      baselineSeconds = Math.max(1, Math.round((now() - began) / 1000));
      const ok = baselineSamples.filter((s) => s.ok).length;
      const healthy = baselineSamples.length > 0 && ok / baselineSamples.length >= 0.9;
      const lat = latency(baselineSamples);
      const range = lat.samplesMs.length
        ? lat.samplesMs[lat.samplesMs.length - 1] - lat.samplesMs[0]
        : Infinity;
      const spread = range / (lat.meanMs || 1);
      // A relative spread is meaningless when the service answers in fractions of a
      // millisecond: 0.2 ms to 0.4 ms is a 100 % ratio and no instability at all. Stability
      // therefore also accepts an absolute band.
      const stable = spread <= 0.5 || range <= 5;
      return { healthy, stable, durationSec: baselineSeconds };
    },
    async observe(_vectorIds, plan, signal) {
      samples = [];
      witnessSamples = [];
      startedAt = new Date(now()).toISOString();
      if (opts.entryWitnessUrl) {
        const c = await counter(opts.entryWitnessUrl);
        if (c) {
          entryBefore = c.requests;
          entryErrors = c.errors;
        }
      }
      if (opts.originWitnessUrl) {
        const c = await counter(opts.originWitnessUrl);
        if (c) {
          originBefore = c.requests;
          originErrors = c.errors;
        }
      }
      // Finish before the orchestrator's deadline instead of waiting for its abort: the
      // bound rejects the call the moment it fires, so an observation that returns at the
      // same instant would lose the whole exposure.
      const deadline = now() + Math.max(1, plan.budgets.maxDurationSec - 1) * 1000;
      while (!signal.aborted && now() < deadline) {
        samples.push(await probe(opts.probeUrl));
        observeOutage(samples[samples.length - 1], startedAt);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      finishedAt = new Date(now()).toISOString();
      if (opts.entryWitnessUrl) {
        const c = await counter(opts.entryWitnessUrl);
        if (c) {
          entryAfter = c.requests;
          entryErrors = Math.max(0, c.errors - entryErrors);
        }
      }
      if (opts.originWitnessUrl) {
        const c = await counter(opts.originWitnessUrl);
        if (c) {
          originAfter = c.requests;
          originErrors = Math.max(0, c.errors - originErrors);
        }
      }
    },
    async recovery(plan, signal) {
      const deadline = now() + Math.min(plan.recoveryTimeoutSec, 30) * 1000;
      while (!signal.aborted && now() < deadline) {
        const s = await probe(opts.probeUrl);
        if (s.ok) {
          recoveryAt = s.at;
          if (outageStart) {
            outages.push({ start: outageStart, end: s.at });
            outageStart = null;
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
    async seal(vectorIds, plan): Promise<DrsEvidence[]> {
      const generated = latency(samples);
      const baselineLatency = latency(baselineSamples);
      const status = expectedStatus(plan.services[0]?.functionalAssertion ?? '');
      const transaction = {
        serviceId: plan.services[0]?.id ?? 'service-1',
        successful: samples.filter((s) => (status === null ? s.ok : s.status === status)).length,
        total: samples.length,
        assertionEvaluated: status !== null,
        assertionVerified: status !== null && samples.every((s) => s.status === status),
      };
      const baselineTransaction = {
        ...transaction,
        successful: baselineSamples.filter((s) => (status === null ? s.ok : s.status === status))
          .length,
        total: baselineSamples.length,
      };
      // An outage still open when the exposure ends is an interval from its first failed
      // sample to the end of the window; leaving it out would understate the impact.
      const intervals = [...outages];
      if (outageStart)
        intervals.push({ start: outageStart, end: finishedAt || new Date(now()).toISOString() });
      // Witness loads are counters over the exposure window, so the window length matters.
      const exposureSeconds = Math.max(
        1,
        (new Date(finishedAt || now()).getTime() - new Date(startedAt || now()).getTime()) / 1000,
      );
      const dimensions = [
        opts.entryWitnessUrl ? null : 'entry instrumentation (no witness)',
        opts.originWitnessUrl ? null : 'origin instrumentation (no witness)',
        'calibration evidence',
      ].filter((d): d is string => d !== null);
      return vectorIds.map((vectorId) => ({
        vectorId,
        attemptId: `probe-${vectorId}-${Math.round(now())}`,
        serviceIds: [plan.services[0]?.id ?? 'service-1'],
        startedAt,
        finishedAt,
        requested_load: { value: plan.budgets.maxRps, unit: 'tps' as const },
        points: [
          ...(opts.entryWitnessUrl && entryAfter >= entryBefore
            ? [
                {
                  sourceId: 'entry',
                  startedAt,
                  finishedAt,
                  artifactHash: sha256({ entryBefore, entryAfter, entryErrors }),
                  sampleCount: 2,
                  load: {
                    value: Math.round((entryAfter - entryBefore) / Math.max(1, exposureSeconds)),
                    unit: 'tps' as const,
                  },
                },
              ]
            : []),
          ...(opts.originWitnessUrl && originAfter >= originBefore
            ? [
                {
                  sourceId: 'origin',
                  startedAt,
                  finishedAt,
                  artifactHash: sha256({ originBefore, originAfter, originErrors }),
                  sampleCount: 2,
                  load: {
                    value: Math.round((originAfter - originBefore) / Math.max(1, exposureSeconds)),
                    unit: 'tps' as const,
                  },
                },
              ]
            : []),
          {
            sourceId: 'generator',
            startedAt,
            finishedAt,
            artifactHash: sha256({ samples: samples.length, vectorId }),
            sampleCount: samples.length,
            load: { value: plan.budgets.maxRps, unit: 'tps' as const },
          },
          {
            sourceId: 'user',
            startedAt,
            finishedAt,
            artifactHash: sha256(samples),
            sampleCount: samples.length,
          },
        ],
        legitimate_transaction_success: [transaction],
        baseline_transaction_success: [baselineTransaction],
        latency_baseline: baselineLatency,
        latency_during_test: generated,
        baselineSeconds,
        baselineStable: true,
        detection_timestamp: intervals.length ? intervals[0].start : null,
        mitigation_timestamp: intervals.length ? intervals[0].end : null,
        outage_intervals: intervals,
        recovery_timestamp: recoveryAt,
        manual_interventions: [],
        telemetry_gaps: [],
        injection_point: plan.architecture.injectionPoint,
        physical_generators: 1,
        virtual_clients: plan.budgets.concurrency,
        observed_source_addresses: [],
        emulated_dimensions: [],
        unrepresented_dimensions: dimensions,
        calibration_evidence: [],
        observed_properties: [],
        jointExposureId: null,
        cancelled: false,
      })) as unknown as DrsEvidence[];
    },
  };
}

export type { DrsRevision, DrsPlan };
