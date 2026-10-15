import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { IO_LIMITS } from '../src/config/limits.js';
import {
  createTargetTelemetryProvider,
  parseTargetSample,
  summarizeTargetTelemetry,
  targetTelemetryConfigFromEnv,
  noopTargetTelemetryProvider,
} from '../src/modules/target-telemetry/provider.js';
const ctx = {
  campaignId: 'campaign&scope=other',
  runId: 'run/one',
  target: 'http://target.test/a?secret=fixture',
};
afterEach(() => vi.restoreAllMocks());
it('uses the bounded HTTP reader and keeps outages, malformed bodies and redirects unknown', async () => {
  let path = '';
  let marker: string | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    path = req.url!;
    marker = req.headers['x-wedos-shieldtest'] as string;
    if (url.pathname === '/failure') {
      res.writeHead(503);
      res.end('{}');
    } else if (url.pathname === '/malformed') res.end('{');
    else if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/sample' });
      res.end();
    } else if (url.pathname === '/oversized') res.end(' '.repeat(IO_LIMITS.responseBytes + 1));
    else if (url.pathname === '/timeout') {
      /* client deadline closes this socket */
    } else
      res.end(
        JSON.stringify({
          nicRxMbps: 12.5,
          receivedRequests: 20,
          receiptComplete: true,
          sourceIps: ['10.1.1.1'],
          targetPodUid: 'pod-one',
        }),
      );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const sample = await createTargetTelemetryProvider({ metricsUrl: base + '/sample' }).sample(
      ctx,
    );
    expect(sample).toMatchObject({ nicRxMbps: 12.5, receivedRequests: 20, receiptComplete: true });
    const query = new URL(path, base);
    expect(query.searchParams.get('campaignId')).toBe(ctx.campaignId);
    expect(query.searchParams.get('runId')).toBe(ctx.runId);
    expect(query.searchParams.get('target')).toBe(ctx.target);
    expect(marker).toBe('target-telemetry-query');
    for (const route of ['failure', 'malformed', 'redirect', 'oversized', 'timeout'])
      await expect(
        createTargetTelemetryProvider({
          metricsUrl: `${base}/${route}`,
          timeoutMs: route === 'timeout' ? 20 : 2000,
        }).sample(ctx),
      ).resolves.toBeNull();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
it('preserves unknown optional receipt fields rather than coercing invalid data into valid counts', async () => {
  for (const value of [true, '', ' ', -1, Infinity, NaN, {}, []])
    expect(parseTargetSample({ nicRxMbps: value })).toBeNull();
  const sample = parseTargetSample({
    cpuPct: '12.5',
    receivedRequests: '20',
    receiptComplete: 'true',
    sourceIps: [1, '10.1.1.1'],
    source: 'x'.repeat(200),
    targetPodUid: 'y'.repeat(200),
  })!;
  expect(sample.receivedRequests).toBeUndefined();
  expect(sample.receiptComplete).toBeUndefined();
  expect(sample.sourceIps).toEqual(['10.1.1.1']);
  expect(sample.source).toHaveLength(128);
  expect(sample.targetPodUid).toHaveLength(128);
  expect(
    targetTelemetryConfigFromEnv({ TARGET_TELEMETRY_TIMEOUT_MS: 'invalid' }).timeoutMs,
  ).toBeUndefined();
  expect(targetTelemetryConfigFromEnv({ TARGET_TELEMETRY_TIMEOUT_MS: ' 20 ' }).timeoutMs).toBe(20);
  expect(() => createTargetTelemetryProvider({ metricsUrl: 'invalid-url' })).toThrow('invalid URL');
  await expect(noopTargetTelemetryProvider.sample(ctx)).resolves.toBeNull();
});
it('marks receipt resets, missing counter samples and changed targets incomplete, preserving raw maxima', () => {
  const first = {
    at: 't1',
    receivedRequests: 100,
    receiptComplete: true,
    targetPodUid: 'one',
    sourceIps: ['10.1.1.1'],
  };
  expect(
    summarizeTargetTelemetry([first, { ...first, receivedRequests: 110, sourceIps: ['10.1.1.2'] }]),
  ).toMatchObject({
    receivedRequestsMax: 110,
    receiptComplete: true,
    sourceIps: ['10.1.1.1', '10.1.1.2'],
  });
  for (const next of [
    { ...first, receivedRequests: 10 },
    { ...first, receivedRequests: undefined },
    { ...first, targetPodUid: 'replacement' },
    { ...first, receiptComplete: false },
  ])
    expect(summarizeTargetTelemetry([first, next])).toMatchObject({
      receivedRequestsMax: expect.any(Number),
      receiptComplete: false,
    });
  expect(
    summarizeTargetTelemetry([{ at: 't', receivedRequests: 1 }]).receiptComplete,
  ).toBeUndefined();
});
