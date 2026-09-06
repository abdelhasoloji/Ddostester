import dgram from 'node:dgram';
import http from 'node:http';
import { assertLabAddressInPrefix } from '../lib/net-guard.mjs';

// Synthetic mitigation node for the closed ShieldTest lab. It sits between the
// reflector and the target and models a scrubber: it measures the incoming rate
// and, once a threshold is sustained past a configurable DETECTION_DELAY, engages
// "mitigation" — forwarding only up to a bounded ceiling and dropping the excess.
// It measures the detection/mitigation problem (delay, residual load, collateral
// on legitimate traffic); it generates no traffic of its own beyond forwarding,
// and only toward a private/loopback target (hard gate).
//
// `createScrubber()` builds an instance and exposes `ingest()`/`tick()` so the
// accounting can be driven deterministically from tests without real sockets.

const ATTACK_TYPE = 'shieldtest.synthetic-amplification';

export function createScrubber(env = process.env) {
  const LISTEN_HOST = env.LISTEN_HOST || '0.0.0.0';
  const LISTEN_PORT = Number(env.LISTEN_PORT || 9005);
  const TARGET_HOST = env.TARGET_HOST || '192.168.100.99';
  const TARGET_PORT = Number(env.TARGET_PORT || 9002);
  const THRESHOLD_PPS = Number(env.THRESHOLD_PPS || 100);
  const CEILING_PPS = Number(env.CEILING_PPS || 50);
  const DETECTION_DELAY_SEC = Number(env.DETECTION_DELAY_SEC || 3);
  const METRICS_PORT = Number(env.METRICS_PORT || 0);

  assertLabAddressInPrefix(TARGET_HOST, env.LAB_CIDR_PREFIX, 'TARGET_HOST');
  if (!Number.isInteger(TARGET_PORT) || TARGET_PORT < 1024 || TARGET_PORT > 65535) {
    throw new Error('TARGET_PORT must be an unprivileged UDP port');
  }
  if (!Number.isFinite(THRESHOLD_PPS) || THRESHOLD_PPS < 1 || THRESHOLD_PPS > 100000) {
    throw new Error('THRESHOLD_PPS must be between 1 and 100000');
  }
  if (!Number.isFinite(CEILING_PPS) || CEILING_PPS < 0 || CEILING_PPS > THRESHOLD_PPS) {
    throw new Error('CEILING_PPS must be between 0 and THRESHOLD_PPS');
  }
  if (
    !Number.isFinite(DETECTION_DELAY_SEC) ||
    DETECTION_DELAY_SEC < 0 ||
    DETECTION_DELAY_SEC > 60
  ) {
    throw new Error('DETECTION_DELAY_SEC must be between 0 and 60');
  }

  const output = dgram.createSocket('udp4');
  let inputSocket = null;
  let metricsServer = null;

  const state = {
    received: 0,
    forwarded: 0,
    dropped: 0,
    droppedAttack: 0,
    droppedLegit: 0,
    mitigating: false,
    detectionDelaySec: null, // measured: mitigation start − first over-threshold second
    // internal accounting
    windowPackets: 0, // packets seen in the current 1s window
    forwardedThisWindow: 0,
    overThresholdSince: null, // seconds counter of sustained over-threshold
  };

  /** Classifies a packet and decides forward vs drop; updates counters. Returns the decision. */
  function ingest(msg) {
    state.received++;
    state.windowPackets++;
    let type = ATTACK_TYPE;
    try {
      const t = JSON.parse(msg.toString('utf8')).type;
      if (typeof t === 'string') type = t;
    } catch {
      /* opaque payload → treated as attack-shaped */
    }
    const isLegit = type !== ATTACK_TYPE;
    // While mitigating, forward only up to the ceiling per window; drop the rest.
    if (state.mitigating && state.forwardedThisWindow >= CEILING_PPS) {
      state.dropped++;
      if (isLegit) state.droppedLegit++;
      else state.droppedAttack++;
      return { forward: false, isLegit };
    }
    state.forwarded++;
    state.forwardedThisWindow++;
    return { forward: true, isLegit };
  }

  /** One-second evaluation: rate check, mitigation engagement, window reset. */
  function tick() {
    const pps = state.windowPackets;
    if (pps > THRESHOLD_PPS) {
      state.overThresholdSince = (state.overThresholdSince ?? 0) + 1;
      if (!state.mitigating && state.overThresholdSince > DETECTION_DELAY_SEC) {
        state.mitigating = true;
        state.detectionDelaySec = state.overThresholdSince; // seconds from first breach to engage
      }
    } else {
      state.overThresholdSince = null; // sustained breach broken (mitigation stays latched)
    }
    state.windowPackets = 0;
    state.forwardedThisWindow = 0;
  }

  const metrics = {
    get received() {
      return state.received;
    },
    get forwarded() {
      return state.forwarded;
    },
    get dropped() {
      return state.dropped;
    },
    get droppedAttack() {
      return state.droppedAttack;
    },
    get droppedLegit() {
      return state.droppedLegit;
    },
    get mitigating() {
      return state.mitigating;
    },
    get detectionDelaySec() {
      return state.detectionDelaySec;
    },
    /** Collateral: share of dropped packets that were legitimate (0 when none dropped). */
    get collateralPct() {
      return state.dropped > 0
        ? Number(((state.droppedLegit / state.dropped) * 100).toFixed(2))
        : 0;
    },
  };

  function renderMetrics() {
    return [
      '# HELP shieldtest_scrubber_received_total Packets received by the scrubber.',
      '# TYPE shieldtest_scrubber_received_total counter',
      `shieldtest_scrubber_received_total ${state.received}`,
      '# HELP shieldtest_scrubber_forwarded_total Packets forwarded to the target.',
      '# TYPE shieldtest_scrubber_forwarded_total counter',
      `shieldtest_scrubber_forwarded_total ${state.forwarded}`,
      '# HELP shieldtest_scrubber_dropped_total Packets dropped by mitigation.',
      '# TYPE shieldtest_scrubber_dropped_total counter',
      `shieldtest_scrubber_dropped_total ${state.dropped}`,
      '# HELP shieldtest_scrubber_dropped_legit_total Legitimate packets dropped (collateral).',
      '# TYPE shieldtest_scrubber_dropped_legit_total counter',
      `shieldtest_scrubber_dropped_legit_total ${state.droppedLegit}`,
      '# HELP shieldtest_scrubber_mitigating Whether mitigation is engaged (1/0).',
      '# TYPE shieldtest_scrubber_mitigating gauge',
      `shieldtest_scrubber_mitigating ${state.mitigating ? 1 : 0}`,
      '# HELP shieldtest_scrubber_detection_delay_seconds Seconds from first over-threshold second to mitigation.',
      '# TYPE shieldtest_scrubber_detection_delay_seconds gauge',
      `shieldtest_scrubber_detection_delay_seconds ${state.detectionDelaySec ?? 0}`,
      '# HELP shieldtest_scrubber_collateral_pct Share of dropped packets that were legitimate.',
      '# TYPE shieldtest_scrubber_collateral_pct gauge',
      `shieldtest_scrubber_collateral_pct ${metrics.collateralPct}`,
      '',
    ].join('\n');
  }

  /**
   * Protection view for the control plane's measured-WRS pull connector.
   * detectionTimeSec = measured delay to engage; mitigationTimeSec = same once
   * engaged (0 while not mitigating). Never throws.
   */
  function protectionJson() {
    const d = state.detectionDelaySec ?? 0;
    return {
      detectionTimeSec: d,
      mitigationTimeSec: state.mitigating ? d : 0,
      source: 'lab-scrubber',
    };
  }

  let ticker = null;
  function start(onReady) {
    inputSocket = dgram.createSocket('udp4');
    inputSocket.on('message', (msg) => {
      if (ingest(msg).forward) output.send(msg, TARGET_PORT, TARGET_HOST, () => {});
    });
    inputSocket.bind(LISTEN_PORT, LISTEN_HOST, () => {
      ticker = setInterval(tick, 1000);
      if (typeof ticker.unref === 'function') ticker.unref();
      if (METRICS_PORT > 0) {
        metricsServer = http.createServer((req, res) => {
          const path = (req.url || '').split('?')[0];
          if (path === '/metrics') {
            res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
            res.end(renderMetrics());
          } else if (path === '/protection') {
            // Closed loop: the control plane's PROTECTION_METRICS_URL pull
            // connector consumes this JSON to feed a MEASURED WRS (D/M).
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(protectionJson()));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        metricsServer.listen(METRICS_PORT, LISTEN_HOST);
      }
      if (onReady) onReady(inputSocket.address().port);
    });
  }

  function stop(done) {
    if (ticker) clearInterval(ticker);
    let pending = 1 + (inputSocket ? 1 : 0) + (metricsServer ? 1 : 0);
    const settle = () => {
      pending--;
      if (pending <= 0 && done) done();
    };
    output.close(settle);
    if (inputSocket) inputSocket.close(settle);
    if (metricsServer) metricsServer.close(settle);
  }

  return { start, stop, ingest, tick, metrics, renderMetrics, protectionJson };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const scrubber = createScrubber();
  scrubber.start((port) => console.log(JSON.stringify({ event: 'scrubber.ready', listen: port })));
  const stop = () => scrubber.stop(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
