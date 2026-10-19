import { randomBytes } from 'node:crypto';
import { buildApp } from '../../../backend/dist/app.js';
import { MemoryStore } from '../../../backend/dist/store/memory.js';
import { initAuth } from '../../../backend/dist/auth/guard.js';
for (const port of [18111, 18112]) {
  const { app } = await buildApp({
    store: new MemoryStore(),
    auth: initAuth({ USER_MODE: 'team', AUTH_JWT_SECRET: randomBytes(32).toString('hex') }),
    allowedTargets: [],
    serveStatic: true,
    logger: false,
  });
  app.addHook('onRequest', async (req, reply) => {
    if (port === 18112 && req.method === 'POST' && req.url === '/api/auth/login')
      return reply.send({
        token: 'visual-fixture-only',
        email: 'review@example.test',
        role: 'admin',
        mustChangePassword: true,
      });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      return reply.code(403).send({ error: 'Visual fixture: changes disabled' });
    if (port === 18112 && req.url === '/api/auth/me')
      return reply.send({
        email: 'review@example.test',
        role: 'admin',
        authRequired: true,
        userMode: 'team',
        mustChangePassword: true,
      });
    if (port === 18112 && req.url.startsWith('/api/'))
      return reply
        .code(503)
        .send({ error: 'Read data intentionally unavailable in forced-change visual fixture' });
  });
  await app.listen({ host: '127.0.0.1', port });
}
console.log('Auth visual fixtures ready');
