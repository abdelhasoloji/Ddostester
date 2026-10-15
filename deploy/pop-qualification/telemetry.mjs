import { readFileSync, writeFileSync } from 'node:fs';

// Passive process/container observations only. No sockets, API clients or assignments.
const localValue = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
};
let sequence = 0;
function sample() {
  const observation = {
    schema: 'shieldtester.passive-telemetry/v1',
    observedAt: new Date().toISOString(),
    sequence: ++sequence,
    scope: 'This process and its visible cgroup; not physical-host or target measurements',
    pod: process.env.POD_NAME ?? null,
    node: process.env.NODE_NAME ?? null,
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    uptimeSec: process.uptime(),
    processMemoryBytes: process.memoryUsage(),
    processCpuMicroseconds: process.cpuUsage(),
    cgroup: {
      memoryCurrentBytes: localValue('/sys/fs/cgroup/memory.current'),
      memoryLimitBytes: localValue('/sys/fs/cgroup/memory.max'),
      cpuStat: localValue('/sys/fs/cgroup/cpu.stat'),
    },
    generatesTraffic: false,
    fleetEnrolled: false,
  };
  writeFileSync('/tmp/telemetry-ready', String(Date.now()), { mode: 0o600 });
  console.log(JSON.stringify(observation));
}
sample();
if (process.env.SAMPLE_ONCE !== '1') {
  const timer = setInterval(sample, 30000);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}
