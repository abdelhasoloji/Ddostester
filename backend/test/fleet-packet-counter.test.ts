import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFleetAssignment } from '../src/modules/fleet/agent.js';
import { buildPacketAssignment } from '../src/modules/fleet/contract.js';
import {
  packetCounterCommand,
  packetCounterSettleMs,
  parsePacketCounter,
  readPacketCounter,
} from '../src/modules/fleet/packet-counter.js';

const COUNTER = `
import { readFileSync, writeFileSync } from 'node:fs';
const [state, step, mode] = process.argv.slice(2);
let s = { n: 0, calls: 0 };
try { s = JSON.parse(readFileSync(state, 'utf8')); } catch {}
s.calls += 1;
if (mode === 'fail-second' && s.calls >= 2) process.exit(3);
s.n = mode === 'backwards' ? (s.calls === 1 ? 1000 : 500) : s.n + Number(step);
writeFileSync(state, JSON.stringify(s));
console.log('packets ' + s.n + ' bytes 0');
`;

const AGENT = `
import { writeFileSync } from 'node:fs';
const sent = Number(process.env.PACKET_TEST_SENT || 500);
process.send({ event: 'packet.emitted', sent });
const received = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 5000);
  process.once('message', (message) => {
    clearTimeout(timer);
    resolve(message?.PACKET_RECEIVED ?? null);
  });
});
writeFileSync(process.env.PACKET_TEST_MARKER, JSON.stringify({ sent, received }));
console.log(JSON.stringify({
  agentId: 'a1', attemptId: 't1', campaignId: 'c1', exitCode: 0,
  packetsSent: sent, packetsReceived: received,
  accepted: received !== null && received >= sent * 0.99,
}));
`;

describe('packet counter reader', () => {
  it('accepts an argv array and nothing else', () => {
    expect(packetCounterCommand({})).toBeNull();
    expect(packetCounterCommand({ PACKET_COUNTER_CMD: '  ' })).toBeNull();
    expect(
      packetCounterCommand({
        PACKET_COUNTER_CMD: JSON.stringify(['nft', 'list', 'counter', 'inet', 'drs_lab', 'x']),
      }),
    ).toEqual(['nft', 'list', 'counter', 'inet', 'drs_lab', 'x']);
    expect(() => packetCounterCommand({ PACKET_COUNTER_CMD: 'nft list counter' })).toThrow(
      'not valid JSON',
    );
    expect(() => packetCounterCommand({ PACKET_COUNTER_CMD: '[]' })).toThrow('argv array');
    expect(() => packetCounterCommand({ PACKET_COUNTER_CMD: '["ssh",5]' })).toThrow(
      'non-empty strings',
    );
  });

  it('bounds the settle delay', () => {
    expect(packetCounterSettleMs({})).toBe(0);
    expect(packetCounterSettleMs({ PACKET_COUNTER_SETTLE_MS: '250' })).toBe(250);
    expect(() => packetCounterSettleMs({ PACKET_COUNTER_SETTLE_MS: '-1' })).toThrow('between 0');
    expect(() => packetCounterSettleMs({ PACKET_COUNTER_SETTLE_MS: '5001' })).toThrow('between 0');
  });

  it('requires exactly one unambiguous count', () => {
    expect(parsePacketCounter('\tpackets 1716869 bytes 68674760\n')).toBe(1716869);
    expect(() => parsePacketCounter('counter syn_rx {\n}\n')).toThrow('exactly one');
    expect(() => parsePacketCounter('packets 10 bytes 0\npackets 20 bytes 0\n')).toThrow(
      'exactly one',
    );
  });

  it('runs the configured command', async () => {
    await expect(
      readPacketCounter([process.execPath, '-e', 'console.log("packets 42 bytes 7")']),
    ).resolves.toBe(42);
  });
});

describe('packet mission target counter', () => {
  let dir: string;
  let agent: string;
  let counter: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'packet-counter-test-'));
    agent = join(dir, 'fake-agent.mjs');
    counter = join(dir, 'counter.mjs');
    await writeFile(agent, AGENT, { mode: 0o600 });
    await writeFile(counter, COUNTER, { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('PACKET_AGENT', agent);
    vi.stubEnv('PACKET_COUNTER_SETTLE_MS', '0');
  });

  const policy = {
    agentId: 'a1',
    allowedHosts: ['lab-target'],
    allowedPorts: [18099],
    caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
  };

  const assignment = () =>
    buildPacketAssignment({
      campaignId: 'c1',
      runId: 'r1',
      agentId: 'a1',
      attemptId: 't1',
      target: 'http://lab-target:18099/',
      port: 18099,
      pps: 500,
      durationSec: 10,
      now: Date.now(),
    });

  const run = () =>
    runFleetAssignment(
      assignment(),
      policy,
      { renew: async () => ({ leaseUntil: Date.now() + 5000 }) },
      undefined,
    );

  let sequence = 0;
  const stateFile = () => join(dir, `state-${++sequence}.json`);
  const marker = () => join(dir, `marker-${++sequence}.json`);

  const readMarker = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

  it('refuses to emit when no counter is configured', async () => {
    const mark = marker();
    vi.stubEnv('PACKET_COUNTER_CMD', '');
    vi.stubEnv('PACKET_TEST_MARKER', mark);
    const result = await run();
    expect(result.state).toBe('FAILED');
    expect(result.reason).toContain('packet counter not configured');
    await expect(readFile(mark)).rejects.toThrow();
  });

  it('fails before emission when the target counter is unreadable', async () => {
    const mark = marker();
    vi.stubEnv('PACKET_COUNTER_CMD', JSON.stringify(['/nonexistent/packet-counter']));
    vi.stubEnv('PACKET_TEST_MARKER', mark);
    const result = await run();
    expect(result.state).toBe('FAILED');
    expect(result.reason).toContain('before emission');
    await expect(readFile(mark)).rejects.toThrow();
  });

  it('hands the measured delta to the agent and succeeds', async () => {
    const state = stateFile();
    const mark = marker();
    vi.stubEnv('PACKET_COUNTER_CMD', JSON.stringify([process.execPath, counter, state, '500']));
    vi.stubEnv('PACKET_TEST_MARKER', mark);
    vi.stubEnv('PACKET_TEST_SENT', '500');
    // Un PACKET_RECEIVED hérité de l'environnement ne doit jamais remplacer la
    // mesure : l'orchestrateur le retire de l'environnement de l'agent.
    vi.stubEnv('PACKET_RECEIVED', '999999');
    const result = await run();
    expect(result).toMatchObject({ state: 'SUCCEEDED', packet: { sent: 500, received: 500 } });
    expect(result.reason).toContain('500 received');
    expect(await readMarker(mark)).toEqual({ sent: 500, received: 500 });
  });

  it('passes the target host, not the signed URL, to the generator', async () => {
    const argv = join(dir, `argv-${++sequence}.json`);
    const generator = join(dir, 'fake-generator.mjs');
    await writeFile(
      generator,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PACKET_TEST_ARGV, JSON.stringify(process.argv.slice(2)));\nconsole.log('sent=500 elapsed=10.00s rate=50');\n",
      { mode: 0o755 },
    );
    vi.stubEnv(
      'PACKET_AGENT',
      fileURLToPath(new URL('../../scripts/fleet/packet-agent.mjs', import.meta.url)),
    );
    vi.stubEnv('PACKET_GENERATOR', generator);
    vi.stubEnv('PACKET_SOURCE_IP', '203.0.113.10');
    vi.stubEnv('PACKET_TEST_ARGV', argv);
    vi.stubEnv(
      'PACKET_COUNTER_CMD',
      JSON.stringify([process.execPath, counter, stateFile(), '500']),
    );
    const result = await run();
    expect(result.state).toBe('SUCCEEDED');
    expect(JSON.parse(await readFile(argv, 'utf8'))).toEqual(['lab-target', '18099', '500', '10']);
  });

  it('fails closed when the target count falls short of 99 %', async () => {
    const state = stateFile();
    const mark = marker();
    vi.stubEnv('PACKET_COUNTER_CMD', JSON.stringify([process.execPath, counter, state, '500']));
    vi.stubEnv('PACKET_TEST_MARKER', mark);
    vi.stubEnv('PACKET_TEST_SENT', '1000');
    const result = await run();
    expect(result.state).toBe('FAILED');
    expect(result.reason).toContain('below 99 %');
    expect(result.packet).toEqual({ sent: 1000, received: 500 });
    expect(await readMarker(mark)).toEqual({ sent: 1000, received: 500 });
  });

  it('fails when the target counter disappears after emission', async () => {
    const state = stateFile();
    vi.stubEnv(
      'PACKET_COUNTER_CMD',
      JSON.stringify([process.execPath, counter, state, '500', 'fail-second']),
    );
    vi.stubEnv('PACKET_TEST_MARKER', marker());
    vi.stubEnv('PACKET_TEST_SENT', '500');
    const result = await run();
    expect(result.state).toBe('FAILED');
    expect(result.reason).toContain('after emission');
  });

  it('fails when the target counter goes backwards', async () => {
    const state = stateFile();
    vi.stubEnv(
      'PACKET_COUNTER_CMD',
      JSON.stringify([process.execPath, counter, state, '500', 'backwards']),
    );
    vi.stubEnv('PACKET_TEST_MARKER', marker());
    vi.stubEnv('PACKET_TEST_SENT', '500');
    const result = await run();
    expect(result.state).toBe('FAILED');
    expect(result.reason).toContain('went backwards');
  });
});
