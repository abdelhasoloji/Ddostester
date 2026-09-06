import { defineConfig } from '@playwright/test';

// E2E runs against the built app served by the backend (SPA + API on one port),
// with auth enabled and two seeded users. Kept separate from the fast unit gate.
const PORT = 8099;
const AUTH_USERS = JSON.stringify([
  {
    email: 'eng@wedos',
    role: 'engineer',
    passwordHash:
      'scrypt$36bb828728cdaa4a33a47a2f53d34d72$9be93e40b43fd77e8f8c77ad7826556e16c91e0a94c4b16374315b43c4ee6f32',
  },
  {
    email: 'off@wedos',
    role: 'officer',
    passwordHash:
      'scrypt$b403e0c7735bda1735328322c1f05ec7$1f6cc661e4a8fc962e54e1564d50227f8b0294b0a33b886d6aeb30b8ee9a0dc0',
  },
]);

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
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
