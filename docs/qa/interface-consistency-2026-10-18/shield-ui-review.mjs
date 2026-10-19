import { liveProgress } from '../../../backend/dist/runtime/live.js';
import { buildApp } from '../../../backend/dist/app.js';
import { MemoryStore } from '../../../backend/dist/store/memory.js';
import { initAuth } from '../../../backend/dist/auth/guard.js';
const store = new MemoryStore();
const now = new Date().toISOString();
for (const [i, host] of ['bank.example', 'enisa-preprod.example', 'lab.example'].entries())
  await store.saveTarget({
    id: 'demo-' + i,
    host,
    displayName: ['Bank', 'ENISA preproduction', 'Qualification lab'][i],
    owner: 'Internal team',
    createdBy: 'demo',
    createdAt: now,
    updatedAt: now,
    authStatus: 'authorized',
  });
const wrs = {
  wrs: 94,
  level: 'A',
  detection: 92,
  mitigation: 85,
  availability: 100,
  collateral: 100,
  estimated: true,
};
const campaign = {
  id: 'demo-completed',
  name: 'DEMONSTRATION — completed campaign with a long descriptive label',
  target: 'https://lab.example/',
  probeUrl: 'https://lab.example/',
  vector: 'http-get',
  maxRps: 50,
  concurrency: 5,
  maxDurationSec: 20,
  createdBy: 'demo',
  authorized: true,
  createdAt: now,
  status: 'COMPLETED',
  runId: 'demo-report',
  wrs,
};
await store.saveCampaign(campaign);
await store.saveCampaign({
  ...campaign,
  id: 'demo-approved',
  name: 'DEMONSTRATION — approved campaign',
  status: 'APPROVED',
  runId: undefined,
  wrs: undefined,
  approvedBy: 'reviewer',
  approvalExpiresAt: new Date(Date.now() + 86400000).toISOString(),
});
await store.saveRun({
  runId: 'demo-report',
  campaignId: campaign.id,
  status: 'COMPLETED',
  engine: 'visual-fixture',
  generator: {
    id: 'demo-generator',
    config: { target: campaign.target, rps: 50, concurrency: 5, durationSec: 20 },
    startedAt: new Date(Date.now() - 20000).toISOString(),
    finishedAt: now,
    totalRequests: 1000,
    successful: 998,
    failed: 2,
    actualRps: 50,
    latencyMs: { min: 1, max: 20, mean: 5, p50: 4, p95: 9, p99: 15 },
    statusCounts: { '2xx': 998, '5xx': 2 },
    errors: {},
  },
  probe: {
    samples: 8,
    available: 8,
    successful: 8,
    errorRate5xx: 0,
    latencyMs: { p50: 3, p95: 6, p99: 9 },
  },
  wrs,
  timeline: Array.from({ length: 20 }, (_, i) => ({
    t: i + 1,
    rps: 50,
    sent: (i + 1) * 50,
    failed: i > 10 ? 2 : 0,
    probe5xx: 0,
    availPct: 100,
  })),
});
await store.saveCampaign({
  ...campaign,
  id: 'demo-running',
  name: 'DEMONSTRATION — live telemetry fixture',
  status: 'RUNNING',
  runId: undefined,
  wrs: undefined,
});
liveProgress.set('demo-running', {
  status: 'RUNNING',
  maxDurationSec: 120,
  engine: 'visual-fixture',
  generatorObserved: true,
  sent: 500,
  successful: 498,
  failed: 2,
  elapsedSec: 10,
  actualRps: 50,
  statusCounts: { '2xx': 498, '5xx': 2 },
  latencyMs: { p50: 4, p95: 9, p99: 15 },
  probe: {
    samples: 8,
    available: 8,
    errorRate5xx: 0,
    latencyMs: { p50: 3, p95: 6, p99: 9 },
    health: 'ok',
  },
  timeline: Array.from({ length: 10 }, (_, i) => ({
    generatorObserved: true,
    successful: (i + 1) * 50 - (i > 5 ? 2 : 0),
    probeSamples: i + 1,
    t: i + 1,
    rps: 50,
    sent: (i + 1) * 50,
    failed: i > 5 ? 2 : 0,
    probe5xx: 0,
    availPct: 100,
  })),
});
const { app } = await buildApp({
  store,
  auth: initAuth({ USER_MODE: 'team' }),
  allowedTargets: ['lab.example'],
  logger: false,
  serveStatic: true,
});
app.addHook('onRequest', async (req, reply) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
    return reply
      .code(403)
      .send({ error: 'Local visual fixture: campaign execution and mutations disabled.' });
});
await app.listen({ host: '127.0.0.1', port: 18110 });
console.log('Local review ready');
