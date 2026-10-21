#!/usr/bin/env node
/**
 * Lab rig for DRS demos: an origin that counts what it serves, and an edge in front of it that
 * counts what reaches it and forwards.
 *
 *   origin  127.0.0.1:8097   (target, counts requests)
 *   edge    127.0.0.1:8098   (generator target, counts and proxies to the origin)
 *   counters at /telemetry on each port: { requests, errors }
 *
 * Two counters, never one: a single counter would report the same number for "what reached the
 * edge" and "what the application served", which is exactly the evidence a DRS assessment must
 * not fabricate.
 */
import { createServer, request } from 'node:http';

const ORIGIN_PORT = Number(process.env.LAB_ORIGIN_PORT ?? 8097);
const EDGE_PORT = Number(process.env.LAB_EDGE_PORT ?? 8098);

const stats = () => ({ requests: 0, errors: 0 });
const originStats = stats();
const edgeStats = stats();

const telemetry = (res, s) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(s));

const origin = createServer((req, res) => {
  if (req.url === '/telemetry') return telemetry(res, originStats);
  originStats.requests += 1;
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>lab</title><h1>ok</h1>');
});

const edge = createServer((req, res) => {
  if (req.url === '/telemetry') return telemetry(res, edgeStats);
  edgeStats.requests += 1;
  const upstream = request(
    { host: '127.0.0.1', port: ORIGIN_PORT, path: req.url, method: req.method, headers: req.headers },
    (upstreamRes) => {
      if ((upstreamRes.statusCode ?? 0) >= 500) edgeStats.errors += 1;
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    edgeStats.errors += 1;
    res.writeHead(502).end('bad gateway');
  });
  req.pipe(upstream);
});

origin.listen(ORIGIN_PORT, '127.0.0.1', () =>
  console.log(`origin  http://127.0.0.1:${ORIGIN_PORT}/  telemetry /telemetry`),
);
edge.listen(EDGE_PORT, '127.0.0.1', () =>
  console.log(`edge    http://127.0.0.1:${EDGE_PORT}/  telemetry /telemetry`),
);

const shutdown = () => {
  origin.close();
  edge.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
