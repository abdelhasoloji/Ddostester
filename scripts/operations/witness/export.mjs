// Forced SSH command. Dedicated DB credentials can SELECT audit, never mutate it.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const previous = (process.env.SSH_ORIGINAL_COMMAND ?? 'GENESIS').trim();
if (!/^([0-9a-f]{64}|GENESIS)$/.test(previous)) throw new Error('Invalid previous audit head');
const config = JSON.parse(await readFile('/etc/ddostester-audit-export.json', 'utf8'));
const working = execFileSync(
  'systemctl',
  ['show', 'ddostester', '--property=WorkingDirectory', '--value'],
  { encoding: 'utf8', timeout: 2000 },
).trim();
if (!working.startsWith('/home/shieldtest/ddostester-releases/') || !working.endsWith('/backend'))
  throw new Error('Unrecognised immutable release');
const { Pool } = createRequire(working + '/package.json')('pg');
const { verifyChain } = await import(
  pathToFileURL(working + '/dist/modules/audit/integrity.js').href
);
const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 2000,
  query_timeout: 10000,
  statement_timeout: 8000,
  options: '-c default_transaction_read_only=on',
  max: 1,
});
try {
  const rows = (
    await pool.query(
      'SELECT id,at,actor,action,campaign_id AS "campaignId",detail,prev_hash AS "prevHash",hash FROM audit ORDER BY seq LIMIT 100001',
    )
  ).rows;
  if (rows.length > 100000) throw new Error('Audit export exceeds verifier budget');
  const entries = rows.map((row) => ({ ...row, at: row.at.toISOString() }));
  const verdict = verifyChain(entries);
  if (!verdict.ok) throw new Error('Audit verification failed');
  if (
    previous !== 'GENESIS' &&
    !entries.some((entry) => entry.hash === previous || entry.prevHash === previous)
  )
    throw new Error('Previous witness head missing from retained audit');
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      at: new Date().toISOString(),
      verified: true,
      headHash: verdict.headHash,
      count: verdict.count,
      previousAuditHead: previous,
    }),
  );
} finally {
  await pool.end();
}
