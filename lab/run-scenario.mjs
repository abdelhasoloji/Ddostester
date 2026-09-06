import { setTimeout as sleep } from 'node:timers/promises';
import { createTarget } from './target/receiver.mjs';
import { createReflector } from './synthetic-reflector/server.mjs';
import { createScrubber } from './scrubber/server.mjs';
import { runGenerator } from './generator/generate.mjs';
import { SCENARIOS, scenarioNames } from './scenarios.mjs';

const LOOPBACK = '127.0.0.1';
const PREFIX = '127.0.0.';

function startAsync(c) {
  return new Promise((resolve) => c.start((port) => resolve(port)));
}
function stopAsync(c) {
  return new Promise((resolve) => c.stop(resolve));
}

/**
 * Runs a named scenario in-process over loopback (target → [scrubber] →
 * reflector → generator), returns a summary. `overrides` shallow-merges into the
 * scenario's generator/scrubber config (used by tests to shorten durations).
 */
export async function runScenario(name, overrides = {}) {
  const cfg = SCENARIOS[name];
  if (!cfg) throw new Error(`unknown scenario ${name}; try: ${scenarioNames().join(', ')}`);
  const gen = { ...cfg.generator, ...overrides.generator };
  const scr = { ...(cfg.scrubber ?? {}), ...overrides.scrubber };

  const target = createTarget({ LISTEN_HOST: LOOPBACK, LISTEN_PORT: '0' });
  const targetPort = await startAsync(target);

  let scrubber = null;
  let scrubberPort = null;
  if (cfg.useScrubber) {
    scrubber = createScrubber({
      LISTEN_HOST: LOOPBACK,
      LISTEN_PORT: '0',
      TARGET_HOST: LOOPBACK,
      TARGET_PORT: String(targetPort),
      LAB_CIDR_PREFIX: PREFIX,
      THRESHOLD_PPS: String(scr.THRESHOLD_PPS ?? 100),
      CEILING_PPS: String(scr.CEILING_PPS ?? 50),
      DETECTION_DELAY_SEC: String(scr.DETECTION_DELAY_SEC ?? 3),
    });
    scrubberPort = await startAsync(scrubber);
  }

  const reflector = createReflector({
    LISTEN_HOST: LOOPBACK,
    LISTEN_PORT: '0',
    TARGET_HOST: LOOPBACK,
    TARGET_PORT: String(cfg.useScrubber ? scrubberPort : targetPort),
    LAB_CIDR_PREFIX: PREFIX,
  });
  const reflectorPort = await startAsync(reflector);

  const genEnv = {
    REFLECTOR_HOST: LOOPBACK,
    REFLECTOR_PORT: String(reflectorPort),
    LAB_CIDR_PREFIX: PREFIX,
    FACTOR: String(gen.FACTOR ?? 10),
    PACKET_FACTOR: String(gen.PACKET_FACTOR ?? 1),
    PPS: String(gen.PPS ?? 50),
    PROFILE: gen.PROFILE ?? 'constant',
    DURATION_SEC: String(gen.DURATION_SEC ?? 4),
    MAX_PACKET_FACTOR: '100',
  };

  const legitEnv =
    cfg.withLegit && scrubber
      ? {
          REFLECTOR_HOST: LOOPBACK,
          REFLECTOR_PORT: String(scrubberPort),
          LAB_CIDR_PREFIX: PREFIX,
          MODE: 'legit',
          PPS: String((overrides.legit ?? cfg.legit)?.PPS ?? 20),
          DURATION_SEC: genEnv.DURATION_SEC,
        }
      : null;

  const [attack] = await Promise.all([
    runGenerator(genEnv),
    legitEnv ? runGenerator(legitEnv) : Promise.resolve(null),
  ]);
  await sleep(300); // drain in-flight UDP

  const summary = {
    scenario: name,
    generator: { sent: attack.sent, profile: attack.profile },
    reflector: {
      requests: reflector.metrics.requests,
      bap: reflector.metrics.bap,
      packetAmplification: reflector.metrics.packetAmplification,
    },
    target: {
      packets: target.metrics.packets,
      avgPps: target.metrics.avgPps,
      avgBps: target.metrics.avgBps,
    },
    scrubber: scrubber
      ? {
          mitigating: scrubber.metrics.mitigating,
          detectionDelaySec: scrubber.metrics.detectionDelaySec,
          dropped: scrubber.metrics.dropped,
          collateralPct: scrubber.metrics.collateralPct,
        }
      : null,
  };

  await stopAsync(reflector);
  if (scrubber) await stopAsync(scrubber);
  await stopAsync(target);
  return summary;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const name = process.argv[2];
  if (!name || !SCENARIOS[name]) {
    console.error(`Usage: node lab/run-scenario.mjs <scenario>\nScenarios:`);
    for (const n of scenarioNames()) console.error(`  ${n} — ${SCENARIOS[n].summary}`);
    process.exit(1);
  }
  runScenario(name)
    .then((s) => console.log(JSON.stringify(s, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
