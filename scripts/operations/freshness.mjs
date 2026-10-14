import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyWitnesses } from './witness/proof.mjs';
let backup = 0;
let replica = 0;
let witness = 0;
try {
  const receipt = JSON.parse(
    await readFile('/var/lib/ddostester-backup-replica/latest.json', 'utf8'),
  );
  if (receipt.encrypted !== true || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error();
  backup = Date.parse(receipt.completedAt) / 1000;
  replica = Date.parse(receipt.replicatedAt) / 1000;
} catch {
  /* Missing or invalid evidence is represented by zero, never by now. */
}
try {
  const directory = '/var/lib/ddostester-audit-witness/records';
  const files = (await readdir(directory))
    .filter((name) => /^\d{13}-[a-f0-9]{64}\.json$/.test(name))
    .sort();
  if (files.length > 100000) throw new Error('Witness verification budget exceeded');
  const records = [];
  for (const file of files) records.push(JSON.parse(await readFile(join(directory, file), 'utf8')));
  verifyWitnesses(records, await readFile('/etc/ddostester-audit-witness/signing-public.pem'));
  witness = Date.parse(records.at(-1)?.content.at) / 1000;
} catch {
  /* Failed signatures must become an observable stale witness. */
}
const valid = (value) =>
  Number.isFinite(value) && value > 0 && value <= Date.now() / 1000 + 60 ? value : 0;
const metrics = Object.entries({
  ddostester_backup_completed_timestamp_seconds: backup,
  ddostester_backup_replicated_timestamp_seconds: replica,
  ddostester_audit_witness_verified_timestamp_seconds: witness,
})
  .map(([name, value]) => `# TYPE ${name} gauge\n${name} ${valid(value)}\n`)
  .join('');
const directory = '/var/lib/prometheus/node-exporter';
const temporary = join(directory, 'ddostester-operations.prom.pending');
await writeFile(temporary, metrics, { mode: 0o644 });
await rename(temporary, join(directory, 'ddostester-operations.prom'));
