import { defineConfig } from '@playwright/test';

// E2E runs against the built app served by the backend (SPA + API on one port),
// with auth enabled and one seeded user per role. Kept separate from the fast
// unit gate.
const PORT = 8099;
// Passwords: engineer-pass / officer-pass / viewer-pass (mirrored in e2e/roles.ts).
const AUTH_USERS = JSON.stringify([
  {
    email: 'eng@wedos',
    role: 'engineer',
    passwordHash:
      'scrypt$db3cbfeac87352ad77f1de222fab4ada$0e228405f0ecdb976695ca05a14817872faa279df02480257ca05ba50a78570a',
  },
  {
    email: 'off@wedos',
    role: 'officer',
    passwordHash:
      'scrypt$854e0be86e1e7a2e60f2e8f49316dc25$cfc8a98d31a5bb311c965b479f41cfb2cf243a7f9e6a809d69f5ca47c2e7afe7',
  },
  {
    email: 'view@wedos',
    role: 'viewer',
    passwordHash:
      'scrypt$4f22c62a55ba0d6c01e744e182164deb$83a20344ae7a7bd2bb1bb13266c6506b427dc1df996b40095951b3ee61c133d8',
  },
  {
    // The approver. `off@wedos`/officer canonicalises to ADMIN (which cannot
    // approve), so a real CISO is needed to exercise the approval journeys.
    email: 'ciso@wedos',
    role: 'ciso',
    passwordHash:
      'scrypt$873e0cb49f5d4650e08acb93a227f20f$fa7646e7670cccaa7453f9c0529660a1b94816ab25c7f91c08c640dc0ad7d686',
  },
]);

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  // One shared, stateful backend (in-memory store) serves every spec, so run
  // serially to avoid cross-worker state races.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    // Use the environment's pre-installed Chromium when PW_CHROMIUM is set
    // (this sandbox); fall back to Playwright's managed browser (CI installs it).
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: 'node backend/dist/server.js',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ALLOWED_TARGETS: 'localhost,127.0.0.1',
      AUTH_JWT_SECRET: 'e2e-secret',
      AUTH_USERS,
    },
  },
});
