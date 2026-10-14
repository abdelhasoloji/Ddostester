import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const database = process.env.DATABASE_URL;
if (process.env.E2E_DISPOSABLE_POSTGRES !== '1' || !database)
  throw new Error('Run through the owned local PostgreSQL gate with --browser-single.');
const url = new URL(database);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/ddostester_gate')
  throw new Error('Single browser fixture requires the disposable loopback gate database.');

export default defineConfig({
  ...base,
  testDir: 'e2e-single',
  webServer: {
    ...base.webServer,
    command: 'node e2e/server.mjs',
    url: 'http://127.0.0.1:8099/health',
    env: {
      ...base.webServer?.env,
      USER_MODE: 'single',
      DATABASE_URL: database,
      E2E_DISPOSABLE_POSTGRES: '1',
    },
  },
});
