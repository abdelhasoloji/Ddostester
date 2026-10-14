import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent, type PreparedLoadRun } from './types.js';
import { prepareMavenGatling } from './gatling-maven.js';
import { runProcess, binaryAvailable, withTempDir } from './proc.js';
import type { ResultMeta } from './results.js';
import { emptyResult } from './results.js';
import { percentile } from '../engine/stats.js';
import { decodeGatling316Log } from './gatling-log.js';
import { IO_LIMITS } from '../config/limits.js';

/**
 * Adapter to Gatling (Java DSL, headless), operated by the team. Bounded HTTP
 * load via closed concurrency and a shared monotonic request gate. Parsing of simulation.log is
 * best-effort (tab-separated format sensitive to the Gatling version).
 */

const jStr = (s: string): string => JSON.stringify(s);

/** Builds a Gatling simulation (Java) — bounded HTTP load. Pure function. */
export function buildGatlingSim(
  config: LoadTestConfig,
  className = 'ShieldTestSimulation',
  measurementPath?: string,
  controlPath?: string,
): string {
  const u = new URL(config.url);
  const method = (config.method ?? 'GET').toLowerCase();
  const path = u.pathname + u.search;
  const renderHeaders = (values: Record<string, string>): string =>
    Object.entries(values)
      .map(([k, v]) => `.header(${jStr(k)}, ${jStr(v)})`)
      .join('');
  const headers = renderHeaders(config.headers ?? {});
  const checks = `.requestTimeout(Duration.ofMillis(${config.timeoutMs ?? 10_000})).check(status().saveAs("ddostesterStatus"), status().gte(200), status().lt(300))`;
  const bodyChain =
    ['post', 'put', 'patch'].includes(method) && config.body != null
      ? `.body(StringBody(${jStr(config.body)}))`
      : '';

  const flow = config.flow?.length ? config.flow : null;
  const record = measurementPath
    ? '.exec(this::recordAttempt).exitHereIf(session -> !session.getBoolean("ddostesterProof"))'
    : '';
  const responseRecord = measurementPath ? '.exec(this::recordResponse)' : '';
  let chain: string;
  const extraImport = '\nimport java.time.Duration;';
  if (flow) {
    chain = flow
      .map((s, i) => {
        const m = s.method.toLowerCase();
        const stepBody =
          (m === 'post' || m === 'put' || m === 'patch') && s.body != null
            ? `.body(StringBody(${jStr(s.body)}))`
            : '';
        const stepHeaders = renderHeaders({ ...config.headers, ...s.headers });
        const exec = `.exec(requestGate)${record}.exec(http(${jStr(s.name ?? `step-${i + 1}`)}).${m}(${jStr(s.url)})${stepHeaders}${stepBody}${checks})${responseRecord}`;
        return s.thinkMs
          ? `${exec}\n      ${controlPath ? `.pause(session -> Duration.ofNanos(Math.max(0L, Math.min(Duration.ofMillis(${s.thinkMs}).toNanos(), deadlineNanos - System.nanoTime()))))` : `.pause(Duration.ofMillis(${s.thinkMs}))`}`
          : exec;
      })
      .join('\n      ');
  } else {
    chain = `.exec(requestGate)${record}.exec(http("req").${method}(${jStr(path)})${headers}${bodyChain}${checks})${responseRecord}`;
  }

  return `import io.gatling.javaapi.core.*;
import io.gatling.javaapi.http.*;${extraImport}
import static io.gatling.javaapi.core.CoreDsl.*;
import static io.gatling.javaapi.http.HttpDsl.*;

public class ${className} extends Simulation {
  private final long intervalNanos = (long) Math.min(Duration.ofSeconds(${config.durationSec}).toNanos() + 1d, Math.ceil(1_000_000_000d / ${config.maxRps}));
  private long nextPermitNanos;
  private volatile long deadlineNanos;
  ${
    measurementPath
      ? `private long startedAttempts;
  private long firstAttemptNanos;
  private long firstAttemptEpoch;
  private final java.util.Map<String, Long> statusCounts = new java.util.TreeMap<>();
  private synchronized void writeEvidence(boolean finished) throws java.io.IOException {
    java.nio.file.Path path = java.nio.file.Path.of(${jStr(measurementPath)});
    java.nio.file.Path temporary = java.nio.file.Path.of(${jStr(measurementPath + '.tmp')});
    long elapsed = firstAttemptNanos == 0 ? 0 : System.nanoTime() - firstAttemptNanos;
    String statuses = statusCounts.entrySet().stream().map(entry -> entry.getKey() + "=" + entry.getValue()).collect(java.util.stream.Collectors.joining(","));
    java.nio.file.Files.writeString(temporary, startedAttempts + "\\t" + firstAttemptEpoch + "\\t" + elapsed + "\\t" + finished + "\\t" + statuses);
    java.nio.file.Files.move(temporary, path, java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
  }
  private synchronized Session recordAttempt(Session session) {
    if (firstAttemptNanos == 0) { firstAttemptNanos = System.nanoTime(); firstAttemptEpoch = System.currentTimeMillis(); }
    startedAttempts++;
    session = session.remove("ddostesterStatus");
    try { writeEvidence(false); return session.set("ddostesterProof", true); }
    catch (java.io.IOException error) { return session.set("ddostesterProof", false); }
  }`
      : ''
  }
  private synchronized Session recordResponse(Session session) {
    if (session.contains("ddostesterStatus")) {
      int code = session.getInt("ddostesterStatus");
      if (code >= 100 && code < 600) statusCounts.merge((code / 100) + "xx", 1L, Long::sum);
    }
    return session;
  }

  private synchronized Session acquirePermit(Session session) {
    long now = System.nanoTime();
    if (deadlineNanos == 0) {
      deadlineNanos = now + Duration.ofSeconds(${config.durationSec}).toNanos();
      nextPermitNanos = now;
    }
    boolean allowed = now >= nextPermitNanos || now >= deadlineNanos;
    if (allowed && now < deadlineNanos) nextPermitNanos = now + intervalNanos;
    return session.set("ddostesterPermit", allowed)
      .set("ddostesterWait", allowed ? Duration.ZERO : Duration.ofNanos(Math.min(nextPermitNanos - now, deadlineNanos - now)));
  }

  {
    ${measurementPath ? 'Runtime.getRuntime().addShutdownHook(new Thread(() -> { try { writeEvidence(true); } catch (java.io.IOException ignored) {} }));' : ''}
    ChainBuilder requestGate = exec(session -> session.set("ddostesterPermit", false))
      .asLongAs(session -> !session.getBoolean("ddostesterPermit"))
      .on(exec(this::acquirePermit)${controlPath ? `.exitHereIf(session -> java.nio.file.Files.exists(java.nio.file.Path.of(${jStr(controlPath + '.stop')})))` : ''}.pause(session -> ${controlPath ? 'Duration.ofNanos(Math.min(100_000_000L, session.<Duration>get("ddostesterWait").toNanos()))' : 'session.<Duration>get("ddostesterWait")'}))
      .exitHereIf(session -> System.nanoTime() >= deadlineNanos${controlPath ? ` || java.nio.file.Files.exists(java.nio.file.Path.of(${jStr(controlPath + '.stop')}))` : ''});
    HttpProtocolBuilder httpProtocol = http.baseUrl(${jStr(u.origin)}).disableFollowRedirect();
    ${
      controlPath
        ? `ChainBuilder startGate = exec(session -> {
      try { java.nio.file.Files.writeString(java.nio.file.Path.of(${jStr(controlPath + '.ready')}), "ready"); }
      catch (java.io.IOException error) { throw new IllegalStateException("Gatling readiness failed", error); }
      return session;
    }).asLongAs(session -> !java.nio.file.Files.exists(java.nio.file.Path.of(${jStr(controlPath + '.start')})))
      .on(pause(Duration.ofMillis(10)));
    ChainBuilder journey = exec(session -> session)${chain};
    ScenarioBuilder scn = scenario("shieldtest").exec(startGate).forever().on(journey);
    setUp(scn.injectOpen(atOnceUsers(${config.concurrency})))`
        : `ScenarioBuilder scn = scenario("shieldtest")
      ${chain};
    setUp(scn.injectClosed(constantConcurrentUsers(${config.concurrency}).during(${config.durationSec})))`
    }
      .protocols(httpProtocol)
      .maxDuration(Duration.ofMillis(${config.durationSec * 1000 + (controlPath ? IO_LIMITS.agentPreparationMs : 0)}));
  }
}
`;
}

export function combineGatlingMeasurements(
  log: string,
  evidence: string,
  meta: ResultMeta,
): LoadTestResult {
  const fields = evidence.trimEnd().split('\t');
  const started = Number(fields[0]);
  const epoch = Number(fields[1]);
  const elapsedNanos = Number(fields[2]);
  if (
    (fields.length !== 4 && fields.length !== 5) ||
    !Number.isSafeInteger(started) ||
    started <= 0 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1e12 ||
    !Number.isSafeInteger(elapsedNanos) ||
    elapsedNanos <= 0 ||
    fields[3] !== 'true'
  ) {
    throw new AgentError('Missing or invalid finalized Gatling attempt evidence.');
  }
  const result = log.trim()
    ? parseGatlingLog(log, meta)
    : { ...emptyResult(meta), latencySampleCount: 0 };
  if (started < result.totalRequests) throw new AgentError('Invalid Gatling attempt counters.');
  result.finalizedRequests = result.totalRequests;
  const statuses: Record<string, number> = {};
  for (const pair of (fields[4] ?? '').split(',').filter(Boolean)) {
    const match = /^([1-5]xx)=([1-9][0-9]*)$/.exec(pair);
    if (!match || Object.hasOwn(statuses, match[1]) || !Number.isSafeInteger(Number(match[2])))
      throw new AgentError('Invalid Gatling HTTP status evidence.');
    statuses[match[1]] = Number(match[2]);
  }
  // Status checks may survive a signal while the buffered native latency log does not.
  if (Object.values(statuses).reduce((sum, value) => sum + value, 0) > started)
    throw new AgentError('Invalid Gatling HTTP status counters.');
  result.statusCounts = statuses;
  result.unfinalizedRequests = started - result.totalRequests;
  result.totalRequests = started;
  result.failed = started - result.successful;
  result.startedAt = new Date(epoch).toISOString();
  result.actualRps = started / (elapsedNanos / 1e9);
  return result;
}

/** Parses Gatling's simulation.log (best-effort) → LoadTestResult. Pure function. */
export function parseGatlingLog(text: string, meta: ResultMeta): LoadTestResult {
  const latencies: number[] = [];
  let total = 0;
  let failed = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('REQUEST')) continue;
    const f = line.split('\t');
    const epochs = f
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 1e12)
      .sort((a, b) => a - b);
    if (epochs.length !== 2 || (!f.includes('OK') && !f.includes('KO'))) {
      throw new AgentError('Malformed Gatling request measurement.');
    }
    total++;
    if (!f.includes('OK')) failed++;
    latencies.push(epochs[1] - epochs[0]);
  }
  if (!total) throw new AgentError('Gatling produced no finalized request measurements.');
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
    latencySampleCount: latencies.length,
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
  readonly prepare?: AttackAgent['prepare'];
  readonly name = 'gatling';
  readonly multiPhase = false;
  readonly flowCapable = true;
  readonly endpointCapable = false;
  readonly correlationCapable = false;
  readonly description =
    'Gatling (native HTTP) — bounded concurrency and request rate, supports multi-step flows; JVM preparation required.';
  constructor(
    private readonly bin = process.env.GATLING_BIN ?? 'gatling.sh',
    private readonly home = process.env.GATLING_HOME,
  ) {
    if (home)
      this.prepare = (input, hosts, signal) => {
        const config = structuredClone(input);
        return prepareMavenGatling(
          home,
          config,
          hosts,
          signal,
          (measurement, control) =>
            buildGatlingSim(config, 'ShieldTestSimulation', measurement, control),
          async (directory, startedAt) =>
            combineGatlingMeasurements(
              await findSimulationLog(join(directory, 'results')),
              await readFile(join(directory, 'attempts.tsv'), 'utf8').catch(() => ''),
              { id: randomUUID(), config, startedAt, finishedAt: new Date().toISOString() },
            ),
        );
      };
  }

  async available(): Promise<boolean> {
    if (this.home) {
      try {
        return (
          (
            await runProcess('sh', [join(this.home, 'mvnw'), '--offline', '--version'], {
              cwd: this.home,
              timeoutMs: 10_000,
            })
          ).code === 0
        );
      } catch {
        return false;
      }
    }
    return binaryAvailable(this.bin, '--help');
  }

  async run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    _onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    if (this.prepare) {
      const prepared: PreparedLoadRun = await this.prepare(config, allowedHosts, killSignal);
      try {
        return await prepared.run(_onProgress);
      } finally {
        await prepared.dispose();
      }
    }
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
    return withTempDir('gatling', async (dir) => {
      const simDir = join(dir, 'sim');
      const resDir = join(dir, 'results');
      const measurementPath = join(dir, 'attempts.tsv');
      await mkdir(simDir, { recursive: true });
      await writeFile(
        join(simDir, 'ShieldTestSimulation.java'),
        buildGatlingSim(config, 'ShieldTestSimulation', measurementPath),
        'utf8',
      );
      const command = this.bin;
      const args = ['-s', 'ShieldTestSimulation', '-sf', simDir, '-rf', resDir, '-rm', 'local'];
      const startedAt = new Date().toISOString();
      const execution = await runProcess(command, args, {
        cwd: this.home,
        killSignal,
        timeoutMs: config.durationSec * 1000 + 15_000,
      });
      if (execution.code !== 0 && !killSignal?.aborted)
        throw new AgentError('Gatling simulation execution failed.');
      const log = await findSimulationLog(resDir);
      return combineGatlingMeasurements(
        log,
        await readFile(measurementPath, 'utf8').catch(() => ''),
        {
          id: randomUUID(),
          config,
          startedAt,
          finishedAt: new Date().toISOString(),
        },
      );
    });
  }
}

async function findSimulationLog(resDir: string): Promise<string> {
  try {
    const runs = await readdir(resDir);
    for (const r of runs) {
      const file = join(resDir, r, 'simulation.log');
      const info = await stat(file).catch(() => null);
      if (info && info.size > IO_LIMITS.processStreamBytes)
        throw new AgentError('Gatling log exceeds byte budget.');
      const log = await readFile(file).catch(() => null);
      if (log?.length) return log[0] === 0 ? decodeGatling316Log(log) : log.toString('utf8');
    }
  } catch (error) {
    if (error instanceof AgentError) throw error;
  }
  return '';
}
