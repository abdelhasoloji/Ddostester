import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';

// The HTML reports' "Print / PDF" button is an inline onclick="window.print()".
// Under the strict CSP (script-src 'self') that handler is blocked and the
// button does nothing; we allow ONLY that exact handler via its hash +
// 'unsafe-hashes'. This test recomputes the hash from the literal handler text,
// so the CSP and the button can never silently drift apart.
const HANDLER = 'window.print()';
const HASH = createHash('sha256').update(HANDLER).digest('base64');

describe('report Print/PDF button CSP allowance', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const built = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({} as NodeJS.ProcessEnv),
      allowedTargets: ['127.0.0.1'],
      logger: false,
      serveStatic: false,
    });
    app = built.app;
  });

  it("CSP allows exactly the reports' window.print() inline handler", async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    const csp = r.headers['content-security-policy'] as string;
    expect(csp).toContain("'unsafe-hashes'");
    expect(csp).toContain(`'sha256-${HASH}'`);
    // The allowance lives on script-src, and inline scripts are still otherwise
    // blocked (no 'unsafe-inline' for scripts).
    expect(csp).toMatch(/script-src [^;]*'self'/);
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  });
});
