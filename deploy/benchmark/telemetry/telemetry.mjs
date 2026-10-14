import { createServer } from 'node:http';
import { stat, open, truncate } from 'node:fs/promises';
const file = process.env.TARGET_LOG_FILE ?? '/var/log/lab/requests.jsonl';
let offset = 0;
let pending = '';
let incomplete = false;
const campaigns = new Map();
async function collect() {
  try {
    const info = await stat(file);
    if (info.size < offset) {
      offset = 0;
      pending = '';
      incomplete = true;
    }
    if (info.size - offset > 1024 * 1024) {
      incomplete = true;
      offset = info.size;
      return;
    }
    const handle = await open(file, 'r');
    try {
      const bytes = Buffer.alloc(info.size - offset);
      const result = await handle.read(bytes, 0, bytes.length, offset);
      offset += result.bytesRead;
      pending += bytes.subarray(0, result.bytesRead).toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          incomplete = true;
          continue;
        }
        if (typeof row.run !== 'string') continue;
        const parts = row.run.split(':');
        if (!/^[0-9a-f-]{36}$/.test(parts[1] ?? '')) continue;
        const campaignId = parts[0] + ':' + parts[1];
        if (!/^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(campaignId)) continue;
        if (!campaigns.has(campaignId) && campaigns.size >= 1000) {
          incomplete = true;
          continue;
        }
        const entry = campaigns.get(campaignId) ?? {
          receivedRequests: 0,
          statusCounts: {},
          sources: new Set(),
          latestRequestAt: 0,
        };
        entry.receivedRequests++;
        entry.statusCounts[row.status] = (entry.statusCounts[row.status] ?? 0) + 1;
        if (typeof row.source === 'string' && entry.sources.size < 16)
          entry.sources.add(row.source);
        entry.latestRequestAt = Number(row.epochSec) * 1000;
        campaigns.set(campaignId, entry);
      }
    } finally {
      await handle.close();
    }
    if (info.size > 8 * 1024 * 1024) {
      await truncate(file);
      offset = 0;
      pending = '';
      incomplete = true;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') incomplete = true;
  }
}
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await collect();
  } finally {
    running = false;
  }
}, 500);
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method !== 'GET' || url.pathname !== '/metrics.json') {
    response.writeHead(404);
    response.end();
    return;
  }
  const runId = url.searchParams.get('runId');
  const id = url.searchParams.get('campaignId') + ':' + runId;
  const data = campaigns.get(id);
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(
    JSON.stringify({
      at: new Date().toISOString(),
      source: 'lab-nginx-receipts/v1',
      targetPodUid: process.env.POD_UID ?? null,
      receivedRequests: runId ? (data?.receivedRequests ?? 0) : null,
      sourceIps: [...(data?.sources ?? [])],
      latestRequestAt: data?.latestRequestAt ?? null,
      receiptComplete: !incomplete,
      statusCounts: data?.statusCounts ?? {},
      cpuPct: null,
      nicRxMbps: null,
      nicTxMbps: null,
    }),
  );
});
server.listen(9101, process.env.TELEMETRY_BIND ?? '127.0.0.1');
process.on('SIGTERM', () => {
  clearInterval(timer);
  server.close();
});
