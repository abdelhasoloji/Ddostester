// Export a witness into an independently retained destination; never overwrite a witness.
import { writeFile, readFile } from 'node:fs/promises';
const [output, previous] = process.argv.slice(2);
if (!output || !process.env.AUDIT_EXPORT_TOKEN)
  throw new Error(
    'Usage: AUDIT_EXPORT_TOKEN=... AUDIT_API_URL=... node scripts/audit-checkpoint.mjs OUTPUT [PREVIOUS]',
  );
const origin = process.env.AUDIT_API_URL ?? 'http://127.0.0.1:8080';
const r = await fetch(new URL('/api/audit/export', origin), {
  headers: { authorization: `Bearer ${process.env.AUDIT_EXPORT_TOKEN}` },
  redirect: 'error',
  signal: AbortSignal.timeout(5000),
});
if (!r.ok) throw new Error(`Audit export HTTP ${r.status}`);
const document = await r.json();
if (!document.verdict?.ok && !document.verification?.ok)
  throw new Error('Audit chain verification failed');
const verdict = document.verdict ?? document.verification;
if (previous) {
  const witness = JSON.parse(await readFile(previous, 'utf8'));
  if (
    witness.headHash !== 'GENESIS' &&
    !document.entries.some((e) => e.hash === witness.headHash || e.prevHash === witness.headHash)
  )
    throw new Error(
      'Previous audit head is missing; investigate truncation or retention before accepting a new witness',
    );
}
await writeFile(
  output,
  JSON.stringify(
    {
      schemaVersion: 1,
      at: new Date().toISOString(),
      headHash: verdict.headHash,
      count: verdict.count,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log('Audit witness exported; retain it independently of the application database.');
