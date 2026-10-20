#!/usr/bin/env node
/**
 * An instrumented target for the DRS witness: an origin that counts what it serves, and an
 * edge that counts what reaches it and forwards to the origin.
 *
 *   node scripts/qa/witness-target.mjs
 *   {"origin":"http://127.0.0.1:41234/","entry":"http://127.0.0.1:41235/",
 *    "originTelemetry":"http://127.0.0.1:41234/telemetry",
 *    "entryTelemetry":"http://127.0.0.1:41235/telemetry"}
 *
 * Two independent counters are the point. A single counter would report the same number for
 * "what reached the edge" and "what the application served", which is exactly the evidence a
 * DRS assessment must not fabricate.
 */
import { createServer, request } from 'node:http';

const counter = () => ({ requests: 0, errors: 0, latencyMs: 0 });

const originStats = counter();
const origin = createServer((req, res) => {
  if (req.url === '/telemetry') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(originStats));
    return;
  }
  const started = process.hrtime.bigint();
  originStats.requests += 1;
  res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  originStats.latencyMs =
    (originStats.latencyMs * (originStats.requests - 1) +
      Number(process.hrtime.bigint() - started) / 1e6) /
    originStats.requests;
});

const entryStats = counter();
const entry = createServer((req, res) => {
  if (req.url === '/telemetry') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(entryStats));
    return;
  }
  entryStats.requests += 1;
  const upstream = request(
    {
      host: '127.0.0.1',
      port: origin.address().port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      if ((upstreamRes.statusCode ?? 0) >= 500) entryStats.errors += 1;
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    entryStats.errors += 1;
    res.writeHead(502).end('bad gateway');
  });
  req.pipe(upstream);
});

await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => entry.listen(0, '127.0.0.1', resolve));

console.log(
  JSON.stringify({
    origin: `http://127.0.0.1:${origin.address().port}/`,
    entry: `http://127.0.0.1:${entry.address().port}/`,
    originTelemetry: `http://127.0.0.1:${origin.address().port}/telemetry`,
    entryTelemetry: `http://127.0.0.1:${entry.address().port}/telemetry`,
  }),
);

const shutdown = () => {
  origin.close();
  entry.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
