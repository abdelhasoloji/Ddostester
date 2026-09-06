// Named, bounded lab scenarios — the UDP-lab counterpart of the control plane's
// curated playbooks. Each is a plain config within the hard caps; the runner
// (run-scenario.mjs) wires target → [scrubber] → reflector → generator in-process
// over loopback and prints a summary. Nothing here can target a public host.

export const SCENARIOS = {
  'amplification-ramp': {
    summary: 'Byte+packet amplification ramping up; watch BAP and target BPS grow.',
    useScrubber: false,
    generator: { SHAPE: 'ramp', FACTOR: 20, PACKET_FACTOR: 2, PPS: 100, DURATION_SEC: 6 },
  },
  'packet-rate-stress': {
    summary: 'High packet amplification at a steady rate; stresses the PPS path.',
    useScrubber: false,
    generator: { SHAPE: 'constant', FACTOR: 1, PACKET_FACTOR: 10, PPS: 150, DURATION_SEC: 6 },
  },
  'mitigation-delay-study': {
    summary: 'Attack through the scrubber; measure detection delay and residual load.',
    useScrubber: true,
    scrubber: { THRESHOLD_PPS: 100, CEILING_PPS: 40, DETECTION_DELAY_SEC: 3 },
    generator: { SHAPE: 'constant', FACTOR: 10, PACKET_FACTOR: 2, PPS: 150, DURATION_SEC: 8 },
  },
  'collateral-study': {
    summary: 'Attack + benign traffic through the scrubber; measure collateral drops.',
    useScrubber: true,
    withLegit: true,
    scrubber: { THRESHOLD_PPS: 80, CEILING_PPS: 30, DETECTION_DELAY_SEC: 2 },
    generator: { SHAPE: 'constant', FACTOR: 5, PACKET_FACTOR: 3, PPS: 120, DURATION_SEC: 8 },
    legit: { PPS: 20, DURATION_SEC: 8 },
  },
};

export function scenarioNames() {
  return Object.keys(SCENARIOS);
}
