import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { startTelemetry } from './telemetry.mjs';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'target-receipts-'));
  const file = join(dir, 'requests.jsonl');
  const telemetry = startTelemetry({ file, port: 0, podUid: 'fixture-pod' });
  await once(telemetry.server, 'listening');
  const origin = `http://127.0.0.1:${telemetry.server.address().port}`;
  const get = async (path) => {
    const r = await fetch(origin + path, { signal: AbortSignal.timeout(2000) });
    assert.equal(r.status, 200);
    return path.startsWith('/metrics.json') ? r.json() : r.text();
  };
  const campaign = randomUUID();
  const run = randomUUID();
  const row = (overrides = {}) =>
    JSON.stringify({
      run: `${campaign}:${run}:lab-iot-01`,
      status: 200,
      source: '10.247.0.71',
      epochSec: 12345,
      ...overrides,
    }) + '\n';
  try {
    await fn({ ...telemetry, file, get, row, campaign, run });
  } finally {
    await telemetry.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('absent log cannot be complete or invent observed request buckets', { timeout: 5000 }, () =>
  fixture(async (f) => {
    await f.collect();
    const json = await f.get(`/metrics.json?campaignId=${f.campaign}&runId=${f.run}`);
    assert.equal(json.receiptComplete, false);
    const text = await f.get('/metrics');
    assert.match(text, /shieldtest_http_target_log_available\{[^}]+\} 0/);
    assert.doesNotMatch(text, /^shieldtest_http_target_received_requests_total\{/m);
    assert.doesNotMatch(text, /^shieldtest_http_target_last_collection_timestamp_seconds\{/m);
  }),
);

test(
  'actual log receipts are isolated by campaign/run and repeated scrapes do not increment them',
  { timeout: 5000 },
  () =>
    fixture(async (f) => {
      const other = randomUUID();
      await writeFile(
        f.file,
        f.row() + f.row() + f.row({ run: `${f.campaign}:${other}:lab-iot-02` }),
      );
      await f.collect();
      await f.collect();
      const text = await f.get('/metrics');
      assert.match(text, new RegExp(`received_requests_total\\{[^}]*run_id="${f.run}"[^}]*\\} 2`));
      assert.match(text, new RegExp(`received_requests_total\\{[^}]*run_id="${other}"[^}]*\\} 1`));
      const json = await f.get(`/metrics.json?campaignId=${f.campaign}&runId=${f.run}`);
      assert.equal(json.receivedRequests, 2);
      assert.equal(json.receiptComplete, true);
      assert.equal(json.cpuPct, null);
      assert.equal(json.nicRxMbps, null);
      assert.ok(!text.includes('10.247.0.71'), 'Source IPs are not metric labels');
      assert.equal(await f.get('/metrics'), text, 'Reading metrics emits no target traffic');
    }),
);

test(
  'partial records stay incomplete until their newline, then count once',
  { timeout: 5000 },
  () =>
    fixture(async (f) => {
      await writeFile(f.file, f.row().trimEnd());
      await f.collect();
      assert.equal(
        (await f.get(`/metrics.json?campaignId=${f.campaign}&runId=${f.run}`)).receiptComplete,
        false,
      );
      await appendFile(f.file, '\n');
      await f.collect();
      const data = await f.get(`/metrics.json?campaignId=${f.campaign}&runId=${f.run}`);
      assert.equal(data.receivedRequests, 1);
      assert.equal(data.receiptComplete, true);
    }),
);

test(
  'same-size inode replacement and a missing observed log cannot regain complete status',
  { timeout: 5000 },
  () =>
    fixture(async (f) => {
      await writeFile(f.file, f.row());
      await f.collect();
      await rename(f.file, f.file + '.old');
      await writeFile(f.file, f.row());
      await f.collect();
      assert.equal(
        (await f.get(`/metrics.json?campaignId=${f.campaign}&runId=${f.run}`)).receiptComplete,
        false,
      );
      await rm(f.file);
      await f.collect();
      await writeFile(f.file, f.row());
      await f.collect();
      assert.match(await f.get('/metrics'), /shieldtest_http_target_collector_complete\{[^}]+\} 0/);
    }),
);

test(
  'malformed records and oversized backlog remain incomplete without fabricated samples',
  { timeout: 5000 },
  () =>
    fixture(async (f) => {
      await writeFile(f.file, '{broken}\n' + f.row());
      await f.collect();
      assert.equal(
        (await f.get(`/metrics.json?campaignId=${f.campaign}&runId=${f.run}`)).receiptComplete,
        false,
      );
      await appendFile(f.file, 'x'.repeat(1024 * 1024 + 1));
      await f.collect();
      assert.match(await f.get('/metrics'), /shieldtest_http_target_collector_complete\{[^}]+\} 0/);
    }),
);

test(
  'the existing bucket ceiling bounds exported series and overflow is incomplete',
  { timeout: 5000 },
  () =>
    fixture(async (f) => {
      const rows = Array.from({ length: 1001 }, () =>
        f.row({ run: `${randomUUID()}:${randomUUID()}:agent` }),
      ).join('');
      await writeFile(f.file, rows);
      await f.collect();
      const text = await f.get('/metrics');
      assert.equal(
        text
          .split('\n')
          .filter((s) => s.startsWith('shieldtest_http_target_received_requests_total{')).length,
        1000,
      );
      assert.ok(text.split('\n').filter((s) => s && !s.startsWith('#')).length <= 3004);
      assert.match(text, /shieldtest_http_target_collector_complete\{[^}]+\} 0/);
    }),
);
