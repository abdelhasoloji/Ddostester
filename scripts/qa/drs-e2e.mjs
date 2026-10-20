#!/usr/bin/env node
/**
 * DRS end-to-end proof, without the control plane.
 *
 * It builds a frozen measured plan, drives the orchestrator with the real generator and
 * probe collector against a loopback target, and asserts that a sealed proof and a final
 * report come out. That is the one thing unit tests cannot show: the loop actually runs.
 *
 *   DRS_BASELINE_FLOOR_SEC=2 node --experimental-strip-types scripts/qa/drs-e2e.mjs
 *
 * CI runs it as part of the DRS job; it takes about fifteen seconds.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const src = (p) => pathToFileURL(new URL(`../../backend/src/${p}`, import.meta.url).pathname).href;
const { defaultPlan, createRevision, currentRevision, freeze } = await import(
  src('modules/drs/workflow.ts')
);
const { orchestrateDrs } = await import(src('modules/drs/orchestrator.ts'));
const { createEngineGeneratorPort } = await import(src('modules/drs/engine-generator.ts'));
const { createProbeCollectorPort } = await import(src('modules/drs/probe-collector.ts'));

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

// Instrumented target: an edge in front of an origin, each with its own counter. The
// generator drives the edge, so entry and origin are observed independently.
const witness = spawn(process.execPath, [new URL('./witness-target.mjs', import.meta.url).pathname], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const witnessInfo = await new Promise((resolve, reject) => {
  let buffered = '';
  witness.stdout.on('data', (chunk) => {
    buffered += chunk.toString();
    const line = buffered.split('\n')[0];
    if (line.includes('"entryTelemetry"')) resolve(JSON.parse(line));
  });
  witness.on('exit', (code) => reject(new Error(`witness target exited (${code})`)));
  setTimeout(() => reject(new Error('witness target did not report its ports')), 5000);
});
const url = witnessInfo.entry;

const campaign = {
  id: 'e2e',
  name: 'DRS e2e',
  status: 'PENDING_APPROVAL',
  createdBy: 'ci',
  createdAt: new Date().toISOString(),
  target: url,
  probeUrl: url,
  authorized: true,
  agent: 'builtin',
  vector: 'http-get',
  maxRps: 50,
  concurrency: 2,
  maxDurationSec: 10,
};

const plan = defaultPlan(campaign, 'measured');
plan.maxLevel = 1;
plan.exposureSec = 10;
plan.baselineMinSec = 5;
plan.excludedVectors = [
  {
    vectorId: 'drs-3.00.00-111001',
    reason: 'not dispatchable by this control plane; reference/import evidence only',
  },
];
const doc = createRevision(undefined, plan, 'ci');
const revision = currentRevision(doc);
freeze(revision, campaign);

const generator = createEngineGeneratorPort({ url, allowedHosts: ['127.0.0.1'] });
const collector = createProbeCollectorPort({
  probeUrl: witnessInfo.origin,
  entryWitnessUrl: witnessInfo.entryTelemetry,
  originWitnessUrl: witnessInfo.originTelemetry,
  baselineMaxSec: 5,
});
const assessment = await orchestrateDrs(revision, 'ci', {
  generator,
  collector,
  signal: new AbortController().signal,
  checkpoint: async () => {},
});
witness.kill('SIGTERM');

const checks = [
  [revision.state === 'FINAL_REPORT', `revision state ${revision.state}`],
  [revision.proofs.length >= 1, `sealed proofs: ${revision.proofs.length}`],
  [assessment.status === 'PARTIAL', `assessment status ${assessment.status}`],
  [assessment.certification === false, 'assessment must not be a certification'],
];
const points = revision.proofs[0]?.data.points.map((p) => p.sourceId) ?? [];
for (const id of ['generator', 'user', 'entry', 'origin'])
  checks.push([points.includes(id), `evidence missing ${id} point`]);
const dimensions = revision.proofs[0]?.data.unrepresented_dimensions ?? [];
checks.push(
  [!dimensions.some((d) => d.startsWith('entry')), 'entry still reported unrepresented'],
  [!dimensions.some((d) => d.startsWith('origin')), 'origin still reported unrepresented'],
);

const failed = checks.filter(([ok]) => !ok).map(([, why]) => why);
if (failed.length) fail(failed.join('; '));

console.log(
  `OK  state=${revision.state} proofs=${revision.proofs.length} status=${assessment.status} ` +
    `points=${points.join(',')} transactions=${revision.proofs[0].data.legitimate_transaction_success[0].successful}/${revision.proofs[0].data.legitimate_transaction_success[0].total}`,
);
