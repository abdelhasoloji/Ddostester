import { BuiltinHttpAgent } from './builtin.js';
import { K6Agent } from './k6.js';
import { VegetaAgent } from './vegeta.js';
import { LocustAgent } from './locust.js';
import { JMeterAgent } from './jmeter.js';
import { GatlingAgent } from './gatling.js';
import type { AttackAgent } from './types.js';

export type { AttackAgent } from './types.js';

/** Agents de charge disponibles (tous en charge HTTP bornée). */
export const AGENTS = ['builtin', 'k6', 'vegeta', 'locust', 'jmeter', 'gatling'] as const;

/** Sélectionne l'agent de charge selon AGENT (builtin par défaut). */
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
