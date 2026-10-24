import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Target-side packet counter.
 *
 * A packet mission proves delivery only with the count taken on the target.
 * The orchestrator reads that count before and after the emission through an
 * operator-configured reader: an explicit argv array, never a shell string.
 * A missing or failing reader refuses the mission instead of emitting
 * unmeasured traffic.
 */
const MAX_ARGS = 16;
const MAX_ARG_CHARS = 4096;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_SETTLE_MS = 5000;

const run = promisify(execFile);

/** Parse the operator-supplied reader command (`PACKET_COUNTER_CMD`, JSON argv). */
export function packetCounterCommand(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.PACKET_COUNTER_CMD?.trim();
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('PACKET_COUNTER_CMD is not valid JSON');
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGS)
    throw new Error(`PACKET_COUNTER_CMD must be an argv array of 1 to ${MAX_ARGS} entries`);
  for (const arg of value) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_ARG_CHARS)
      throw new Error('PACKET_COUNTER_CMD entries must be non-empty strings');
    if (arg.includes('\0')) throw new Error('PACKET_COUNTER_CMD entries must not contain NUL');
  }
  return value as string[];
}

/** Delay between the end of the emission and the "after" read (ms). */
export function packetCounterSettleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PACKET_COUNTER_SETTLE_MS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SETTLE_MS)
    throw new Error(`PACKET_COUNTER_SETTLE_MS must be an integer between 0 and ${MAX_SETTLE_MS}`);
  return value;
}

/**
 * Read a single `nft list counter` style output and return its packet count.
 * Ambiguity is an error: two counters in one output must never be silently
 * reduced to the first match.
 */
export function parsePacketCounter(output: string): number {
  const counts = [...output.matchAll(/\bpackets\s+(\d+)\b/g)];
  if (counts.length !== 1)
    throw new Error(`packet counter output must contain exactly one count, found ${counts.length}`);
  const value = Number(counts[0][1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('packet counter is not a count');
  return value;
}

/** Run the configured reader once and return the absolute target count. */
export async function readPacketCounter(
  command: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<number> {
  const { stdout } = await run(command[0], command.slice(1), {
    timeout: timeoutMs,
    // A reader that ignores SIGTERM would otherwise hold the mission open.
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    shell: false,
  });
  return parsePacketCounter(stdout);
}
