import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { initAuth } from '../src/auth/guard.js';
import { MemoryStore } from '../src/store/memory.js';

// The service binds loopback behind Caddy. Fastify inject lets a test set the peer address,
// which is the difference between "the proxy forwarded this" and "the client claimed it".
const build = async () => {
  const built = await buildApp({
    store: new MemoryStore(),
    auth: initAuth({ USER_MODE: 'team' }),
    allowedTargets: [],
    logger: false,
    serveStatic: false,
  });
  built.app.get('/whoami', async (req) => ({ ip: req.ip }));
  return built.app;
};

describe('forwarded client address', () => {
  it('takes the client address from a loopback proxy', async () => {
    const app = await build();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/whoami',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.json()).toEqual({ ip: '203.0.113.7' });
    } finally {
      await app.close();
    }
  });

  it('ignores a forwarded header from a non-loopback peer', async () => {
    const app = await build();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/whoami',
        remoteAddress: '198.51.100.9',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.json()).toEqual({ ip: '198.51.100.9' });
    } finally {
      await app.close();
    }
  });
});
