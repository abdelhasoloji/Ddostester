import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig, iterationRate } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import { runProcess, binaryAvailable } from './proc.js';

/**
 * Adapter to Gatling (Java DSL, headless), operated by the team. Bounded HTTP
 * load via constantUsersPerSec (≈ RPS). Parsing of simulation.log is
 * best-effort (tab-separated format sensitive to the Gatling version).
 */

const jStr = (s: string): string => JSON.stringify(s);

/** Builds a Gatling simulation (Java) — bounded HTTP load. Pure function. */
export function buildGatlingSim(
  config: LoadTestConfig,
  className = 'ShieldTestSimulation',
): string {
  const u = new URL(config.url);
  const method = (config.method ?? 'GET').toLowerCase();
  const path = u.pathname + u.search;
  const headers = Object.entries(config.headers ?? {})
    .map(([k, v]) => `.header(${jStr(k)}, ${jStr(v)})`)
    .join('');
  const bodyChain =
    method === 'post' && config.body != null ? `.body(StringBody(${jStr(config.body)}))` : '';

  const flow = config.flow?.length ? config.flow : null;
  // A flow runs N requests per user, so cap the user arrival rate at maxRps/N.
  const usersPerSec = flow ? iterationRate(config.maxRps, flow.length) : config.maxRps;

  let chain: string;
  let extraImport = '';
  if (flow) {
    extraImport = '\nimport java.time.Duration;';
    chain = flow
      .map((s, i) => {
        const m = s.method.toLowerCase();
        const stepBody =
          (m === 'post' || m === 'put' || m === 'patch') && s.body != null
            ? `.body(StringBody(${jStr(s.body)}))`
            : '';
        const exec = `.exec(http(${jStr(s.name ?? `step-${i + 1}`)}).${m}(${jStr(s.url)})${headers}${stepBody})`;
        return s.thinkMs ? `${exec}\n      .pause(Duration.ofMillis(${s.thinkMs}))` : exec;
      })
      .join('\n      ');
  } else {
    chain = `.exec(http("req").${method}(${jStr(path)})${headers}${bodyChain})`;
  }

  return `import io.gatling.javaapi.core.*;
import io.gatling.javaapi.http.*;${extraImport}
import static io.gatling.javaapi.core.CoreDsl.*;
import static io.gatling.javaapi.http.HttpDsl.*;

public class ${className} extends Simulation {
  {
    HttpProtocolBuilder httpProtocol = http.baseUrl(${jStr(u.origin)});
    ScenarioBuilder scn = scenario("shieldtest")
      ${chain};
    setUp(scn.injectOpen(constantUsersPerSec(${usersPerSec}).during(${config.durationSec})))
      .protocols(httpProtocol);
  }
}
`;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, i)].toFixed(2));
}

/** Parses Gatling's simulation.log (best-effort) → LoadTestResult. Pure function. */
export function parseGatlingLog(
  text: string,
  meta: { id: string; config: LoadTestConfig; startedAt: string; finishedAt: string },
): LoadTestResult {
  const latencies: number[] = [];
  let total = 0;
  let failed = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('REQUEST')) continue;
    const f = line.split('\t');
    total++;
    const ok = f.includes('OK');
    if (!ok) failed++;
    const epochs = f
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 1e12)
      .sort((a, b) => a - b);
    if (epochs.length >= 2) latencies.push(epochs[epochs.length - 1] - epochs[0]);
  }
  latencies.sort((a, b) => a - b);
  const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const elapsedSec = (Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)) / 1000;
  return {
    id: meta.id,
    config: meta.config,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    totalRequests: total,
    successful: total - failed,
    failed,
    statusCounts: {},
    latencyMs: {
      min: latencies[0] ?? 0,
      max: latencies[latencies.length - 1] ?? 0,
      mean: Number(mean.toFixed(2)),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    actualRps: Number((total / Math.max(elapsedSec, 0.001)).toFixed(2)),
    errors: {},
  };
}

export class GatlingAgent implements AttackAgent {
  readonly name = 'gatling';
  readonly multiPhase = false;
  readonly flowCapable = true;
  readonly correlationCapable = false;
  readonly description =
    'Gatling (external, headless) — constant users/sec, supports multi-step flows; heavy (JVM).';
  constructor(private readonly bin = process.env.GATLING_BIN ?? 'gatling.sh') {}

  available(): Promise<boolean> {
    return binaryAvailable(this.bin, '--help');
  }

  async run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    _onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    validateConfig(config, allowedHosts);
    if (config.phases?.length) {
      throw new AgentError(
        'Multi-phase scenario not supported by the gatling agent — use AGENT=k6 or vegeta.',
      );
    }
    if (!(await this.available())) {
      throw new AgentError(
        `gatling agent unavailable (binary "${this.bin}"). Install Gatling or choose AGENT=builtin.`,
      );
    }
    const dir = await mkdtemp(join(tmpdir(), 'shieldtest-gatling-'));
    const simDir = join(dir, 'sim');
    const resDir = join(dir, 'results');
    const startedAt = new Date().toISOString();
    try {
      // Gatling compiles the sources found in -sf: we place the simulation there.
      await mkdir(simDir, { recursive: true });
      await writeFile(join(simDir, 'ShieldTestSimulation.java'), buildGatlingSim(config), 'utf8');
      await runProcess(
        this.bin,
        ['-s', 'ShieldTestSimulation', '-sf', simDir, '-rf', resDir, '-rm', 'local'],
        { killSignal },
      );
      const log = await findSimulationLog(resDir);
      return parseGatlingLog(log, {
        id: randomUUID(),
        config,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function findSimulationLog(resDir: string): Promise<string> {
  try {
    const runs = await readdir(resDir);
    for (const r of runs) {
      const log = await readFile(join(resDir, r, 'simulation.log'), 'utf8').catch(() => '');
      if (log) return log;
    }
  } catch {
    /* nothing */
  }
  return '';
}
