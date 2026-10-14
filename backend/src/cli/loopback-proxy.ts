import { IO_LIMITS } from '../config/limits.js';
import { createServer, createConnection, type Socket } from 'node:net';
import { classifyBindHost } from '../util/bind.js';
const host = process.env.POD_IP;
if (!host || classifyBindHost(host) !== 'private') throw new Error('Private pod address required');
const sockets = new Set<Socket>();
const server = createServer((client) => {
  if (sockets.size >= IO_LIMITS.operatorProxyConnections) {
    client.destroy();
    return;
  }
  const upstream = createConnection({ host, port: 8080 });
  sockets.add(client);
  const close = () => {
    sockets.delete(client);
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', close);
  upstream.on('close', close);
  client.setTimeout(IO_LIMITS.operatorProxyIdleMs, close);
  upstream.setTimeout(IO_LIMITS.operatorProxyIdleMs, close);
  client.pipe(upstream);
  upstream.pipe(client);
});
server.listen(8081, '127.0.0.1');
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close();
});
