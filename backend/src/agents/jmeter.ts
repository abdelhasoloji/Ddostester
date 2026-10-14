import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import { runProcess, binaryAvailable, withTempDir } from './proc.js';
import { emptyResult, type ResultMeta } from './results.js';
import { percentile } from '../engine/stats.js';
import { htmlEscape as xmlEsc } from '../util/text.js';
import { parseMeasurementCsv } from './csv-measurements.js';

/**
 * Adapter to Apache JMeter (headless), operated by the team. Bounded HTTP load:
 * rate capped via a shared monotonic request timer. Multi-phase scenarios
 * are delegated to k6/vegeta.
 */

/** Builds a JMeter test plan (.jmx) — bounded HTTP load. Pure function. */
export function buildJmxPlan(config: LoadTestConfig): string {
  const pacing = `<JSR223Timer guiclass="TestBeanGUI" testclass="JSR223Timer" testname="shared-request-pacing" enabled="true">
    <stringProp name="scriptLanguage">groovy</stringProp>
    <stringProp name="cacheKey">true</stringProp>
    <stringProp name="script">${xmlEsc(`
def lock = props.computeIfAbsent('ddostester.lock') { new java.util.concurrent.locks.ReentrantLock() }
lock.lockInterruptibly()
try {
    long now = System.nanoTime()
    if (!props.containsKey('ddostester.deadline.nano')) {
        long remaining = props.get('ddostester.deadline_ms') == null ? ${config.durationSec * 1000}L : props.get('ddostester.deadline_ms').toLong() - System.currentTimeMillis()
        props.put('ddostester.deadline.nano', now + Math.max(0L, remaining) * 1000000L)
    }
    long deadline = props.get('ddostester.deadline.nano')
    long due = props.get('ddostester.next.nano') ?: now
    if (due >= deadline) { ctx.getThread().stop(); return 0L }
    if (due > now) java.util.concurrent.TimeUnit.NANOSECONDS.sleep(due - now)
    now = System.nanoTime()
    if (now >= deadline) { ctx.getThread().stop(); return 0L }
    props.put('ddostester.next.nano', now + ${Math.ceil(1e9 / config.maxRps)}L)
    long started = (props.get('ddostester.started') ?: 0L) + 1L
    props.put('ddostester.started', started)
    if (props.get('ddostester.starts_file') != null) new File(props.get('ddostester.starts_file')).text = started.toString()
} catch (Exception failure) { ctx.getThread().stop(); throw failure } finally { lock.unlock() }
return 0L
`)}</stringProp>
  </JSR223Timer><hashTree/>`;
  const renderHeaders = (headers: Record<string, string>): string =>
    Object.entries(headers)
      .map(
        ([k, v]) => `<elementProp name="" elementType="Header">
  <stringProp name="Header.name">${xmlEsc(k)}</stringProp>
  <stringProp name="Header.value">${xmlEsc(v)}</stringProp>
</elementProp>`,
      )
      .join('\n');

  // Each HTTP sampler shares one pacing lock; non-HTTP pauses do not spend slots.
  const steps = config.flow?.length
    ? config.flow
    : [{ method: config.method ?? 'GET', url: config.url, body: config.body, thinkMs: undefined }];

  const sampler = (
    step: {
      method: string;
      url: string;
      body?: string;
      thinkMs?: number;
      headers?: Record<string, string>;
    },
    i: number,
  ): string => {
    const su = new URL(step.url);
    const headerRows = renderHeaders({ ...config.headers, ...step.headers });
    const method = step.method.toUpperCase();
    const port = su.port || (su.protocol === 'https:' ? '443' : '80');
    const path = su.pathname + su.search;
    const body =
      (method === 'POST' || method === 'PUT' || method === 'PATCH') && step.body != null
        ? step.body
        : '';
    const think = step.thinkMs
      ? `
          <TestAction guiclass="TestActionGui" testclass="TestAction" testname="think-after-request" enabled="true">
            <intProp name="ActionProcessor.action">1</intProp>
            <intProp name="ActionProcessor.target">0</intProp>
            <stringProp name="ActionProcessor.duration">${step.thinkMs}</stringProp>
          </TestAction>
          <hashTree/>`
      : '';
    return `        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="step-${i + 1}" enabled="true">
          <stringProp name="HTTPSampler.domain">${xmlEsc(su.hostname)}</stringProp>
          <stringProp name="HTTPSampler.port">${port}</stringProp>
          <stringProp name="HTTPSampler.protocol">${su.protocol.replace(':', '')}</stringProp>
          <stringProp name="HTTPSampler.path">${xmlEsc(path)}</stringProp>
          <stringProp name="HTTPSampler.method">${method}</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">false</boolProp>
          <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
          <stringProp name="HTTPSampler.connect_timeout">${config.timeoutMs ?? 10_000}</stringProp>
          <stringProp name="HTTPSampler.response_timeout">${config.timeoutMs ?? 10_000}</stringProp>
          <boolProp name="HTTPSampler.postBodyRaw">${body ? 'true' : 'false'}</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">${
              body
                ? `<elementProp name="" elementType="HTTPArgument"><boolProp name="HTTPArgument.always_encode">false</boolProp><stringProp name="Argument.value">${xmlEsc(body)}</stringProp><stringProp name="Argument.metadata">=</stringProp></elementProp>`
                : ''
            }</collectionProp>
          </elementProp>
        </HTTPSamplerProxy>
        <hashTree>
          ${pacing}
          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="2xx-only" enabled="true">
            <collectionProp name="Asserion.test_strings"><stringProp name="status">2[0-9][0-9]</stringProp></collectionProp>
            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
            <boolProp name="Assertion.assume_success">false</boolProp>
            <intProp name="Assertion.test_type">1</intProp>
          </ResponseAssertion>
          <hashTree/>
          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="headers" enabled="true">
            <collectionProp name="HeaderManager.headers">${headerRows}</collectionProp>
          </HeaderManager>
          <hashTree/>
        </hashTree>${think}`;
  };

  const samplers = steps.map(sampler).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="ShieldTest" enabled="true">
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="tg" enabled="true">
        <stringProp name="ThreadGroup.num_threads">\${__groovy(props.get('ddostester.deadline_ms') == null || props.get('ddostester.deadline_ms').toLong() - System.currentTimeMillis() >= 1000 ? ${config.concurrency} : 0)}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">1</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">\${__groovy(props.get('ddostester.deadline_ms') == null ? ${config.durationSec} : (props.get('ddostester.deadline_ms').toLong() - System.currentTimeMillis() >= 1000 ? ((props.get('ddostester.deadline_ms').toLong() - System.currentTimeMillis()) / 1000).longValue() : 1))}</stringProp>
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
          <boolProp name="LoopController.continue_forever">true</boolProp>
          <stringProp name="LoopController.loops">-1</stringProp>
        </elementProp>
      </ThreadGroup>
      <hashTree>
${samplers}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;
}

/** Parses a JMeter JTL file (CSV) → LoadTestResult. Pure function. */
export function parseJtl(csv: string, meta: ResultMeta): LoadTestResult {
  const lines = parseMeasurementCsv(csv);
  if (lines.length < 2) throw new AgentError('JMeter did not produce request measurements.');
  const header = lines[0];
  const iElapsed = header.indexOf('elapsed');
  const iSuccess = header.indexOf('success');
  const iCode = header.indexOf('responseCode');
  if ([iElapsed, iSuccess, iCode].some((index) => index < 0))
    throw new AgentError('Missing JMeter measurement columns.');
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  let failed = 0;
  let total = 0;
  for (const f of lines.slice(1)) {
    if (
      f.length !== header.length ||
      !/^\d+$/.test(f[iElapsed]) ||
      !['true', 'false'].includes(f[iSuccess])
    )
      throw new AgentError('Malformed JMeter request measurement.');
    total++;
    const el = Number(f[iElapsed]);
    if (!Number.isSafeInteger(el)) throw new AgentError('Invalid JMeter latency measurement.');
    latencies.push(el);
    if (f[iSuccess] !== 'true') failed++;
    const code = f[iCode] ?? '';
    if (/^[1-5][0-9]{2}$/.test(code)) {
      const bucket = `${code[0]}xx`;
      statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
    }
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
    statusCounts,
    latencySampleCount: latencies.length,
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

/** Keep pre-I/O attempt evidence even when an interrupted tool never flushed its JTL. */
export function combineJMeterMeasurements(
  csv: string,
  started: number,
  meta: ResultMeta,
  elapsedMs: number,
): LoadTestResult {
  if (
    !Number.isSafeInteger(started) ||
    started <= 0 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  )
    throw new AgentError('Invalid JMeter attempt evidence.');
  const hasRows = csv.trim().split('\n').filter(Boolean).length > 1;
  const result = hasRows ? parseJtl(csv, meta) : { ...emptyResult(meta), latencySampleCount: 0 };
  if (started < result.totalRequests) throw new AgentError('Invalid JMeter attempt counters.');
  result.finalizedRequests = result.totalRequests;
  result.unfinalizedRequests = started - result.totalRequests;
  result.totalRequests = started;
  result.failed = started - result.successful;
  result.actualRps = started / (elapsedMs / 1000);
  return result;
}

export class JMeterAgent implements AttackAgent {
  readonly name = 'jmeter';
  readonly multiPhase = false;
  readonly flowCapable = true;
  readonly endpointCapable = false;
  readonly correlationCapable = false;
  readonly description =
    'Apache JMeter (external, headless) — constant throughput, supports multi-step flows; heavy (JVM).';
  constructor(private readonly bin = process.env.JMETER_BIN ?? 'jmeter') {}

  available(): Promise<boolean> {
    return withTempDir('jmeter-version', (dir) =>
      binaryAvailable(this.bin, ['--version', '-j', join(dir, 'version.log')]),
    );
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
        'Multi-phase scenario not supported by the jmeter agent — use AGENT=k6 or vegeta.',
      );
    }
    if (!(await this.available())) {
      throw new AgentError(
        `jmeter agent unavailable (binary "${this.bin}"). Install JMeter or choose AGENT=builtin.`,
      );
    }
    const startedAt = new Date().toISOString();
    const began = performance.now();
    return withTempDir('jmeter', async (dir) => {
      const plan = join(dir, 'plan.jmx');
      const jtl = join(dir, 'results.jtl');
      const starts = join(dir, 'started.txt');
      await writeFile(plan, buildJmxPlan(config), 'utf8');
      await runProcess(
        this.bin,
        [
          '-n',
          '-t',
          plan,
          '-l',
          jtl,
          '-j',
          join(dir, 'jmeter.log'),
          `-Jddostester.deadline_ms=${Date.now() + config.durationSec * 1000}`,
          `-Jddostester.starts_file=${starts}`,
        ],
        {
          killSignal,
          timeoutMs: config.durationSec * 1000,
        },
      );
      const csv = await readFile(jtl, 'utf8').catch(() => '');
      const started = Number(await readFile(starts, 'utf8').catch(() => 'invalid'));
      return combineJMeterMeasurements(
        csv,
        started,
        {
          id: randomUUID(),
          config,
          startedAt,
          finishedAt: new Date().toISOString(),
        },
        performance.now() - began,
      );
    });
  }
}
