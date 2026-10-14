import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export function parseCgroupCpu(
  text: string,
): { throttledUsec: number; throttledPeriods: number } | null {
  const values = new Map<string, string>();
  for (const line of text.trim().split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2 || values.has(fields[0])) return null;
    values.set(fields[0], fields[1]);
  }
  const read = (key: string) => {
    const value = values.get(key);
    if (!value || !/^\d+$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  };
  const throttledUsec = read('throttled_usec');
  const throttledPeriods = read('nr_throttled');
  return throttledUsec === null || throttledPeriods === null
    ? null
    : { throttledUsec, throttledPeriods };
}
async function cgroupCpu() {
  try {
    return parseCgroupCpu(await readFile('/sys/fs/cgroup/cpu.stat', 'utf8'));
  } catch {
    return null;
  }
}
export interface FleetResources {
  schema: 'ddostester.fleet.resources/v1';
  elapsedMs: number;
  processCpuUserUsec: number;
  processCpuSystemUsec: number;
  processRssBytesAtFinish: number;
  processPeakRssBytesLifetime: number;
  cgroupThrottledUsecDelta: number | null;
  cgroupThrottledPeriodsDelta: number | null;
}
/** Process measurements and cgroup-v2 deltas have distinct, explicit scopes. */
export function startResourceMeasurement(): () => Promise<FleetResources> {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const initial = cgroupCpu();
  return async () => {
    const usage = process.cpuUsage(cpu);
    const elapsedMs = performance.now() - started;
    const rss = process.memoryUsage().rss;
    const peak = process.resourceUsage().maxRSS * 1024;
    const [before, after] = await Promise.all([initial, cgroupCpu()]);
    const delta = (key: 'throttledUsec' | 'throttledPeriods') =>
      before && after && after[key] >= before[key] ? after[key] - before[key] : null;
    return {
      schema: 'ddostester.fleet.resources/v1',
      elapsedMs,
      processCpuUserUsec: usage.user,
      processCpuSystemUsec: usage.system,
      processRssBytesAtFinish: rss,
      processPeakRssBytesLifetime: peak,
      cgroupThrottledUsecDelta: delta('throttledUsec'),
      cgroupThrottledPeriodsDelta: delta('throttledPeriods'),
    };
  };
}
