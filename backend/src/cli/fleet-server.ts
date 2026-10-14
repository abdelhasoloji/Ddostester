import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { FleetCoordinator } from '../modules/fleet/coordinator.js';
import { buildFleetServer } from '../modules/fleet/server.js';
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};
const pool = new pg.Pool({
  connectionString: required('DATABASE_URL'),
  connectionTimeoutMillis: 2000,
  query_timeout: 2500,
  statement_timeout: 2000,
  lock_timeout: 1500,
});
const coordinator = new FleetCoordinator(pool);
await coordinator.init();
const app = buildFleetServer(
  coordinator,
  {
    key: await readFile(required('FLEET_TLS_KEY')),
    cert: await readFile(required('FLEET_TLS_CERT')),
    ca: await readFile(required('FLEET_TLS_CA')),
  },
  required('FLEET_AGENT_IDS').split(','),
  (process.env.FLEET_REVOKED_CERT_SHA256 ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
await app.listen({
  host: process.env.FLEET_BIND ?? '127.0.0.1',
  port: Number(process.env.FLEET_PORT ?? 8443),
});
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await pool.end();
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
