// Bounded Kubernetes inventory observer: no campaign or target traffic.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
if (process.argv[2] === 'prepare') {
  let configuration;
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      configuration = await readFile('/incoming/enrollment.json', 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!configuration || Buffer.byteLength(configuration) > 8192)
    throw new Error('Enrollment unavailable');
  const enrollment = JSON.parse(configuration);
  if (enrollment.privateIp !== process.env.POD_IP)
    throw new Error('Pod IP changed; reconcile inventory and enrollment before restart');
  await writeFile('/work/enrollment.json', configuration, { mode: 0o600 });
  for (const name of ['server-ca.crt', 'client.crt', 'client.key'])
    await writeFile('/work/' + name, await readFile('/incoming/' + name), { mode: 0o600 });
} else {
  const enrollment = JSON.parse(await readFile('/work/enrollment.json', 'utf8'));
  if (enrollment.privateIp !== process.env.POD_IP)
    throw new Error('Pod IP does not match enrolled identity');
  const child = spawn(
    process.execPath,
    ['/observer/heartbeat-agent.mjs', '/work/enrollment.json', '86400'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  // Le runtime 2 exécute le même worker : la capacité v2 doit lancer l'agent,
  // pas seulement le déclarer.
  const worker = ['1', '2'].includes(process.env.FLEET_MISSION_RUNTIME ?? '')
    ? spawn(process.execPath, ['/observer/mission-agent.mjs', '/work/enrollment.json'], {
        stdio: 'inherit',
      })
    : null;
  worker?.once('error', () => child.kill('SIGTERM'));
  worker?.once('close', (code) => {
    if (code !== 0) child.kill('SIGTERM');
  });
  child.once('close', () => worker?.kill('SIGTERM'));
  let buffer = '';
  let marker = Promise.resolve();
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines)
      if (/^Heartbeat accepted sequence=[0-9]+$/.test(line))
        marker = marker.then(() =>
          writeFile('/work/last-accepted', String(Date.now()), { mode: 0o600 }),
        );
  });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      child.kill(signal);
      worker?.kill(signal);
    });
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    process.exitCode = code ?? 1;
  });
}
