// Read-only collector for the dedicated local lab. Explicit kubeconfig is mandatory.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [kubeconfig, runId, destination] = process.argv.slice(2);
if (!kubeconfig || !destination || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId ?? ''))
  throw new Error('Usage: lab-evidence.mjs KUBECONFIG RUN_UUID NEW_PRIVATE_DIRECTORY');
const command = (args) =>
  execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
const config = JSON.parse(command(['config', 'view', '--minify', '-o', 'json']));
const server = new URL(config.clusters?.[0]?.cluster?.server ?? '');
if (
  config['current-context'] !== 'kind-ddostester-lab' ||
  server.protocol !== 'https:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)
)
  throw new Error('Evidence collection requires the dedicated loopback kind lab');
const read = (args) => JSON.parse(command(['-n', 'ddostester-lab', ...args, '-o', 'json']));
const jobs = read(['get', 'jobs', '-l', `app=lab-agent,runId=${runId}`]).items;
if (
  jobs.length > 3 ||
  jobs.some((job) => !new RegExp(`^fleet-${runId}-(one|two|three)$`).test(job.metadata.name))
)
  throw new Error('Unexpected lab Job selection');
const pods = read(['get', 'pods', '-l', `app=lab-agent,runId=${runId}`]).items;
if (pods.length > 3) throw new Error('Unexpected lab pod count');
const receipts = [];
for (const pod of pods) {
  const owner = pod.metadata.ownerReferences?.find((ref) => ref.kind === 'Job');
  const job = jobs.find((job) => job.metadata.uid === owner?.uid);
  if (!job) continue;
  let logs = null;
  try {
    logs = command([
      '-n',
      'ddostester-lab',
      'logs',
      pod.metadata.name,
      '-c',
      'agent',
      '--limit-bytes=65536',
      '--tail=200',
      '--timestamps=true',
    ]);
  } catch {
    /* Missing logs remain unknown, not empty evidence. */
  }
  receipts.push({
    job: {
      name: job.metadata.name,
      uid: job.metadata.uid,
      status: job.status,
      images: job.spec.template.spec.containers.map((container) => container.image),
    },
    pod: {
      name: pod.metadata.name,
      uid: pod.metadata.uid,
      ip: pod.status.podIP,
      phase: pod.status.phase,
      containerStatuses: pod.status.containerStatuses,
    },
    logs,
  });
}
const content = {
  schema: 'ddostester.lab.runtime-evidence/v1',
  runId,
  collectedAt: new Date().toISOString(),
  context: config['current-context'],
  receipts,
  missingJobs: jobs.length === 0,
  limitations: [
    'A collection after cleanup cannot recover removed logs.',
    'Logs are private operator evidence and may contain application diagnostics.',
  ],
};
const serialized = JSON.stringify(content);
await mkdir(destination, { mode: 0o700 });
await writeFile(
  join(destination, 'runtime-evidence.json'),
  JSON.stringify({ content, sha256: createHash('sha256').update(serialized).digest('hex') }) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(JSON.stringify({ collected: receipts.length, missingJobs: content.missingJobs }));
