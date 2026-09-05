import { BuiltinHttpAgent } from './builtin.js';
import { K6Agent } from './k6.js';
import { VegetaAgent } from './vegeta.js';
import { LocustAgent } from './locust.js';
import { JMeterAgent } from './jmeter.js';
import { GatlingAgent } from './gatling.js';
import type { AttackAgent } from './types.js';

export type { AttackAgent } from './types.js';

/** Available load agents (all bounded HTTP load). */
export const AGENTS = ['builtin', 'k6', 'vegeta', 'locust', 'jmeter', 'gatling'] as const;

/** Selects the load agent based on AGENT (builtin by default). */
export function selectAgent(env = process.env): AttackAgent {
  switch ((env.AGENT ?? 'builtin').toLowerCase()) {
    case 'k6':
      return new K6Agent();
    case 'vegeta':
      return new VegetaAgent();
    case 'locust':
      return new LocustAgent();
    case 'jmeter':
      return new JMeterAgent();
    case 'gatling':
      return new GatlingAgent();
    default:
      return new BuiltinHttpAgent();
  }
}
