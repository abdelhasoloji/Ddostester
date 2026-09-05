import { BuiltinHttpAgent } from './builtin.js';
import { K6Agent } from './k6.js';
import type { AttackAgent } from './types.js';

export type { AttackAgent } from './types.js';

/** Sélectionne l'agent de charge selon AGENT (builtin par défaut). */
export function selectAgent(env = process.env): AttackAgent {
  switch ((env.AGENT ?? 'builtin').toLowerCase()) {
    case 'k6':
      return new K6Agent();
    default:
      return new BuiltinHttpAgent();
  }
}
