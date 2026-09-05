import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import { runProcess, binaryAvailable } from './proc.js';

/**
 * Adapter to Apache JMeter (headless), operated by the team. Bounded HTTP load:
 * rate capped via a (shared) Constant Throughput Timer. Multi-phase scenarios
 * are delegated to k6/vegeta.
 */

const xmlEsc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

/** Builds a JMeter test plan (.jmx) — bounded HTTP load. Pure function. */
export function buildJmxPlan(config: LoadTestConfig): string {
  const throughputPerMin = config.maxRps * 60; // Constant Throughput Timer = req/min
  const headerRows = Object.entries(config.headers ?? {})
    .map(
      ([k, v]) => `<elementProp name="" elementType="Header">
  <stringProp name="Header.name">${xmlEsc(k)}</stringProp>
  <stringProp name="Header.value">${xmlEsc(v)}</stringProp>
</elementProp>`,
    )
    .join('\n');

  // A flow is a sequence of samplers; a single request is a 1-step flow. The
  // SHARED Constant Throughput Timer (calcMode 3) caps the TOTAL samples/min
  // across all samplers, so the request rate stays ≤ maxRps regardless of the
  // number of steps.
  const steps = config.flow?.length
    ? config.flow
    : [{ method: config.method ?? 'GET', url: config.url, body: config.body, thinkMs: undefined }];

  const sampler = (
    step: { method: string; url: string; body?: string; thinkMs?: number },
    i: number,
  ): string => {
    const su = new URL(step.url);
    const method = step.method.toUpperCase();
    const port = su.port || (su.protocol === 'https:' ? '443' : '80');
    const path = su.pathname + su.search;
    const body =
      (method === 'POST' || method === 'PUT' || method === 'PATCH') && step.body != null
        ? step.body
        : '';
    const think = step.thinkMs
      ? `
          <ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="think" enabled="true">
            <stringProp name="ConstantTimer.delay">${step.thinkMs}</stringProp>
          </ConstantTimer>
          <hashTree/>`
      : '';
    return `        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="step-${i + 1}" enabled="true">
          <stringProp name="HTTPSampler.domain">${xmlEsc(su.hostname)}</stringProp>
          <stringProp name="HTTPSampler.port">${port}</stringProp>
          <stringProp name="HTTPSampler.protocol">${su.protocol.replace(':', '')}</stringProp>
          <stringProp name="HTTPSampler.path">${xmlEsc(path)}</stringProp>
          <stringProp name="HTTPSampler.method">${method}</stringProp>
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
          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="headers" enabled="true">
            <collectionProp name="HeaderManager.headers">${headerRows}</collectionProp>
          </HeaderManager>
          <hashTree/>${think}
        </hashTree>`;
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
        <stringProp name="ThreadGroup.num_threads">${config.concurrency}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">1</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">${config.durationSec}</stringProp>
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
          <boolProp name="LoopController.continue_forever">true</boolProp>
          <stringProp name="LoopController.loops">-1</stringProp>
        </elementProp>
      </ThreadGroup>
      <hashTree>
${samplers}
        <ConstantThroughputTimer guiclass="TestBeanGUI" testclass="ConstantThroughputTimer" testname="rate" enabled="true">
          <doubleProp><name>throughput</name><value>${throughputPerMin}</value></doubleProp>
          <intProp name="calcMode">3</intProp>
        </ConstantThroughputTimer>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, i)].toFixed(2));
}

/** Parses a JMeter JTL file (CSV) → LoadTestResult. Pure function. */
export function parseJtl(
  csv: string,
  meta: { id: string; config: LoadTestConfig; startedAt: string; finishedAt: string },
): LoadTestResult {
  const lines = csv.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return empty(meta);
  const header = lines[0].split(',');
  const iElapsed = header.indexOf('elapsed');
  const iSuccess = header.indexOf('success');
  const iCode = header.indexOf('responseCode');
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  let failed = 0;
  let total = 0;
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    total++;
    const el = Number(f[iElapsed]);
    if (Number.isFinite(el)) latencies.push(el);
    if (f[iSuccess] !== 'true') failed++;
    const code = f[iCode] ?? '';
    if (code) {
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

function empty(meta: {
  id: string;
  config: LoadTestConfig;
  startedAt: string;
  finishedAt: string;
}): LoadTestResult {
  return {
    ...meta,
    totalRequests: 0,
    successful: 0,
    failed: 0,
    statusCounts: {},
    latencyMs: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 },
    actualRps: 0,
    errors: {},
  };
}

export class JMeterAgent implements AttackAgent {
  readonly name = 'jmeter';
  readonly multiPhase = false;
  readonly flowCapable = true;
  readonly description =
    'Apache JMeter (external, headless) — constant throughput, supports multi-step flows; heavy (JVM).';
  constructor(private readonly bin = process.env.JMETER_BIN ?? 'jmeter') {}

  available(): Promise<boolean> {
    return binaryAvailable(this.bin, '--version');
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
    const dir = await mkdtemp(join(tmpdir(), 'shieldtest-jmeter-'));
    const startedAt = new Date().toISOString();
    try {
      const plan = join(dir, 'plan.jmx');
      const jtl = join(dir, 'results.jtl');
      await writeFile(plan, buildJmxPlan(config), 'utf8');
      await runProcess(this.bin, ['-n', '-t', plan, '-l', jtl, '-j', join(dir, 'jmeter.log')], {
        killSignal,
      });
      const csv = await readFile(jtl, 'utf8').catch(() => '');
      return parseJtl(csv, {
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
