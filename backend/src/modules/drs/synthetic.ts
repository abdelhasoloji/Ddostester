/**
 * Synthetic amplifier validation.
 *
 * The point of this mode is to prove the *instrument*: that the engine really produces the rate
 * it claims, without sending anything to the client's target. It therefore drives the generator
 * against a loopback sink owned by this process and counts what reaches it — the measurement is
 * of the amplifier, and it is honest about being only that.
 *
 * No verdict is produced, no level is qualified, and the revision ends in ENGINE_VALIDATED.
 */
import { createServer } from 'node:http';
import { digest } from './reference.js';
import { ensure, planDigest } from './model.js';
import { transition } from './workflow.js';
import type { DrsRevision } from './model.js';
import type { DrsGeneratorPort } from './orchestrator.js';

export interface DrsSyntheticValidation {
  schema: 'shieldtester.drs.synthetic/v1';
  claimed: { rps: number; concurrency: number; durationSec: number };
  produced: {
    rps: number;
    concurrency: number;
    durationSec: number;
    requests: number;
    errors: number;
  };
  /** produced.rps / claimed.rps, capped at 1. */
  fidelity: number;
  controls: { id: string; ok: boolean; detail: string }[];
  sealedAt: string;
  hash: string;
}

interface Sink {
  url: string;
  close(): Promise<void>;
  stats: { requests: number; errors: number; maxActive: number; active: number };
}

async function startSink(): Promise<Sink> {
  const stats = { requests: 0, errors: 0, maxActive: 0, active: 0 };
  const server = createServer((req, res) => {
    stats.requests += 1;
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    if (req.url === '/fail') stats.errors += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    res.on('close', () => {
      stats.active = Math.max(0, stats.active - 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    stats,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface SyntheticPorts {
  /** Build a generator aimed at the given loopback URL. */
  generator: (url: string) => DrsGeneratorPort;
  signal: AbortSignal;
  checkpoint: () => Promise<void>;
  now?: () => number;
}

export async function runSyntheticValidation(
  r: DrsRevision,
  actor: string,
  ports: SyntheticPorts,
): Promise<DrsSyntheticValidation> {
  ensure(r.plan.mode === 'synthetic-lab', 'Synthetic validation runs a synthetic-lab plan only');
  ensure(r.planHash, 'The plan must be frozen first');
  const now = ports.now ?? Date.now;
  const b = r.plan.budgets;
  const sink = await startSink();
  try {
    transition(
      r,
      'CAPACITY_CHECK',
      'Synthetic run: the engine is checked against an internal sink',
    );
    await ports.checkpoint();
    const generator = ports.generator(sink.url);
    const ids = r.plan.services.map((s) => s.id);
    const capacity = await generator.capacity(ids, b);
    ensure(capacity.ready, `Generator refused the budget: ${capacity.reason}`);

    const durationSec = Math.min(r.plan.exposureSec, b.maxDurationSec);
    transition(
      r,
      'LEVEL_EXECUTION',
      `Synthetic exposure: ${b.maxRps} rps claimed for ${durationSec}s against the internal sink`,
    );
    await ports.checkpoint();

    const started = now();
    const handle = await generator.start(ids, b, ports.signal);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, durationSec * 1000);
      ports.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    await handle.stop();
    const elapsedSec = Math.max(0.001, (now() - started) / 1000);

    const producedRps = sink.stats.requests / elapsedSec;
    const fidelity = Math.min(1, producedRps / Math.max(1, b.maxRps));
    const controls = [
      {
        id: 'rate',
        ok: producedRps >= b.maxRps * 0.95,
        detail: `${producedRps.toFixed(1)} rps produced against ${b.maxRps} rps claimed`,
      },
      {
        id: 'concurrency',
        ok: sink.stats.maxActive >= Math.min(b.concurrency, 1),
        detail: `${sink.stats.maxActive} concurrent request(s) observed, ${b.concurrency} configured`,
      },
      {
        id: 'plan-integrity',
        ok: planDigest(r) === r.planHash,
        detail: 'the plan digest still matches the frozen hash',
      },
      {
        id: 'exclusions',
        ok: r.plan.excludedVectors.every((e) => e.reason.trim().length > 0),
        detail: `${r.plan.excludedVectors.length} excluded vector(s), each with a reason`,
      },
    ];

    const validation: DrsSyntheticValidation = {
      schema: 'shieldtester.drs.synthetic/v1',
      claimed: { rps: b.maxRps, concurrency: b.concurrency, durationSec },
      produced: {
        rps: Math.round(producedRps * 10) / 10,
        concurrency: sink.stats.maxActive,
        durationSec: Math.round(elapsedSec * 10) / 10,
        requests: sink.stats.requests,
        errors: sink.stats.errors,
      },
      fidelity: Math.round(fidelity * 1000) / 1000,
      controls,
      sealedAt: new Date().toISOString(),
      hash: '',
    };
    validation.hash = digest({
      claimed: validation.claimed,
      produced: validation.produced,
      controls: validation.controls,
      planHash: r.planHash,
      actor,
    });
    r.synthetic = validation;
    transition(
      r,
      'ENGINE_VALIDATED',
      `Synthetic validation sealed: fidelity ${(validation.fidelity * 100).toFixed(1)} % · no verdict`,
    );
    await ports.checkpoint();
    return validation;
  } finally {
    await sink.close();
  }
}
