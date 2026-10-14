import { readFile } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

async function throttling() {
  try {
    const text = await readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
    const line = /^throttled_usec (\d+)$/m.exec(text);
    const value = line ? Number(line[1]) : NaN;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Bounded recent process window, independent of request start/finish. */
export function createRecentLoopMonitor({
  histogram = monitorEventLoopDelay({ resolution: 20 }),
  now = () => performance.now(),
  schedule = true,
} = {}) {
  let start = now();
  const windows = [];
  histogram.enable();
  const rotate = () => {
    const end = now();
    windows.push({ start, end, samples: histogram.count, maxMs: histogram.count ? histogram.max / 1e6 : null });
    if (windows.length > 10) windows.shift();
    histogram.reset();
    start = end;
  };
  const timer = schedule ? setInterval(rotate, 1000) : null;
  timer?.unref();
  return {
    rotate,
    snapshot() {
      const end = now();
      const recent = windows.filter((window) => window.end > end - 10000);
      recent.push({ start, end, samples: histogram.count, maxMs: histogram.count ? histogram.max / 1e6 : null });
      const windowMs = end - recent[0].start;
      const samples = recent.reduce((sum, window) => sum + window.samples, 0);
      if (windowMs < 0 || windowMs > 120000 || !samples) return null;
      return { scope: 'process-recent-window', windowMs, samples,
        maxMs: Math.max(...recent.flatMap((window) => window.maxMs === null ? [] : [window.maxMs])) };
    },
    close() { if (timer) clearInterval(timer); histogram.disable(); },
  };
}
const recentLoop = createRecentLoopMonitor();

/** Process-level diagnostic; overlapping requests share CPU/cgroup accounting. */
export async function beginProbeQuality() {
  const before = await throttling();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  return async () => {
    loop.disable();
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const after = await throttling();
    return {
      schema: 'ddostester.probe.quality/v1',
      scope: 'process-during-measurement',
      elapsedMs,
      cpuUserUsec: used.user,
      cpuSystemUsec: used.system,
      rssBytes: process.memoryUsage().rss,
      eventLoopDelayMaxMs: loop.count > 0 ? loop.max / 1e6 : null,
      cgroupThrottledUsecDelta:
        before !== null && after !== null && after >= before ? after - before : null,
      sampledAt: new Date().toISOString(),
      recentEventLoop: recentLoop.snapshot(),
    };
  };
}
