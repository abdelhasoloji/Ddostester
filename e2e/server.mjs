process.env.CAMPAIGN_CATALOG ??= 'legacy';
// Own dedicated loopback target and disposable in-memory control plane.
import { createServer, request as forwardRequest } from 'node:http';
import { spawn } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
const target = createServer((request, response) => {
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 65536) request.destroy();
  });
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'application/json', server: 'dedicated-e2e-target' });
    response.end('{"healthy":true}');
  });
});
await new Promise((resolve, reject) => {
  target.once('error', reject);
  target.listen(8100, '127.0.0.1', resolve);
});
const backend = spawn(process.execPath, ['backend/dist/server.js'], {
  env: {
    ...process.env,
    PORT: '8098',
    DATABASE_URL: process.env.E2E_DISPOSABLE_POSTGRES === '1' ? process.env.DATABASE_URL : '',
    SCHEDULER: 'off',
    FLEET_ENABLED: '0',
  },
  stdio: 'inherit',
});
const streams = new Set();
const proxy = createServer((request, response) => {
  if (request.url === '/__e2e/interrupt-streams') {
    if (
      request.method !== 'POST' ||
      !process.env.E2E_STREAM_CONTROL_TOKEN ||
      request.headers.authorization !== 'Bearer ' + process.env.E2E_STREAM_CONTROL_TOKEN
    ) {
      response.writeHead(403).end();
      return;
    }
    const interrupted = streams.size;
    for (const stream of streams) stream();
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ interrupted }));
    return;
  }
  const upstream = forwardRequest(
    {
      hostname: '127.0.0.1',
      port: 8098,
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      const isStream = /\/api\/campaigns\/[^/]+\/stream(?:\?|$)/.test(request.url ?? '');
      const interrupt = () => {
        incoming.destroy();
        upstream.destroy();
        response.destroy();
      };
      if (isStream) streams.add(interrupt);
      response.once('close', () => {
        streams.delete(interrupt);
        incoming.destroy();
        upstream.destroy();
      });
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(503);
    response.end();
  });
  request.pipe(upstream);
});
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  backend.kill('SIGTERM');
  target.closeAllConnections();
  target.close();
  proxy.closeAllConnections();
  proxy.close();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
backend.on('error', (error) => {
  console.error(error.message);
  stop();
  process.exitCode = 1;
});
backend.on('exit', (code) => {
  stop();
  process.exitCode = code ?? 0;
});
try {
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(8099, '127.0.0.1', resolve);
  });
} catch (error) {
  stop();
  throw error;
}
