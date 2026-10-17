import { BENCH_SCENARIOS } from '../bench/model.js';

// Shape associations only: never grant DRS execution capability or a vector verdict.
const SHAPES: Record<string, { scenarioId: string; representedDimensions: string[] }> = {
  '11001': {
    scenarioId: 'tcp_synflood',
    representedDimensions: ['bounded TCP connection pressure; not SYN packet semantics'],
  },
  '22003': {
    scenarioId: 'udp_maxpackets',
    representedDimensions: ['bounded UDP packet-rate shape'],
  },
  '23006': {
    scenarioId: 'udp_ntp_reflection',
    representedDimensions: ['synthetic NTP-like response-size and packet shape'],
  },
  '24012': {
    scenarioId: 'udp_multivector',
    representedDimensions: ['concurrent synthetic UDP shapes'],
  },
  '54016': {
    scenarioId: 'pulsewave_l34',
    representedDimensions: ['bounded UDP bursts; not application transactions'],
  },
  '54032': {
    scenarioId: 'pulsewave_l34',
    representedDimensions: ['bounded UDP bursts; not application transactions'],
  },
  '54035': {
    scenarioId: 'pulsewave_l34',
    representedDimensions: ['bounded UDP bursts; not application transactions'],
  },
  '26028': {
    scenarioId: 'udp_multivector',
    representedDimensions: ['synthetic response-size and packet shapes'],
  },
};

export function syntheticApproximation(sourceTypeId: string) {
  const shape = SHAPES[sourceTypeId];
  if (!shape || !BENCH_SCENARIOS.some((s) => s.id === shape.scenarioId && s.reproducible))
    return undefined;
  return {
    ...shape,
    mode: 'synthetic-lab' as const,
    qualification: 'partial-shape' as const,
    missingDimensions: [
      'Full protocol and application semantics',
      'Standard load, duration and source diversity',
      'Independent complete DRS evidence and calibration',
    ],
    scoreEligible: false as const,
  };
}
