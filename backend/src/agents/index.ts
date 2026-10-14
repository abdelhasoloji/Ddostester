import { FleetHttpAgent } from './fleet.js';
import { PersistentFleetHttpAgent } from './persistent-fleet.js';
import { BuiltinHttpAgent } from './builtin.js';
import { K6Agent } from './k6.js';
import { VegetaAgent } from './vegeta.js';
import { LocustAgent } from './locust.js';
import { JMeterAgent } from './jmeter.js';
import { GatlingAgent } from './gatling.js';
import type { AttackAgent } from './types.js';
import { AgentError } from './types.js';

export type { AttackAgent } from './types.js';

/** Factory per agent id. Insertion order defines AGENTS order. */
const FACTORIES: Record<string, () => AttackAgent> = {
  builtin: () => new BuiltinHttpAgent(),
  k6: () => new K6Agent(),
  vegeta: () => new VegetaAgent(),
  locust: () => new LocustAgent(),
  jmeter: () => new JMeterAgent(),
  gatling: () => new GatlingAgent(),
};

if (process.env.FLEET_ENABLED === '1') FACTORIES.fleet = () => new FleetHttpAgent();
if (process.env.FLEET_MISSIONS_ENABLED === '1')
  FACTORIES.fleet = () => new PersistentFleetHttpAgent();

/** Available load agent ids (all bounded HTTP load). */
export const AGENTS: string[] = Object.keys(FACTORIES);

/** Resolves an agent by id (e.g. 'k6'); undefined if unknown. */
export function createAgent(id: string | undefined): AttackAgent | undefined {
  if (!id) return undefined;
  if (id.toLowerCase() === 'fleet')
    return process.env.FLEET_MISSIONS_ENABLED === '1'
      ? new PersistentFleetHttpAgent()
      : new FleetHttpAgent();
  const factory = FACTORIES[id.toLowerCase()];
  return factory ? factory() : undefined;
}

/** Selects the load agent based on AGENT (builtin by default). */
export function selectAgent(env = process.env): AttackAgent {
  const selected = createAgent(env.AGENT ?? 'builtin');
  if (!selected) throw new AgentError('Configured agent is unknown');
  return selected;
}

/** Explicit selections are never substituted with the server's default engine. */
export async function resolveCampaignAgent(
  id: string | undefined,
  fallback: AttackAgent,
): Promise<AttackAgent> {
  const selected = id ? createAgent(id) : fallback;
  if (!selected) throw new AgentError('Requested campaign agent is unknown');
  if (!(await selected.available()))
    throw new AgentError('Requested campaign agent is unavailable');
  return selected;
}

export interface AgentInfo {
  /** Stable id used in the API and the campaign.agent field (e.g. 'k6'). */
  id: string;
  /** Display name reported by the agent (e.g. 'builtin-http'). */
  name: string;
  /** Whether the underlying tool is installed/usable on this host. */
  available: boolean;
  /** Whether the agent supports bounded multi-phase scenarios (ramp/waves). */
  multiPhase: boolean;
  /** Whether the agent can run a multi-step request flow (L7 journey). */
  flowCapable: boolean;
  /** Whether the agent honours a multi-URL endpoint set (recon-seeded surface). */
  endpointCapable: boolean;
  /** Whether the agent supports flow correlation. */
  correlationCapable: boolean;
  description: string;
}

/** Agent ids + capabilities without probing availability (cheap, sync). */
export function agentChoices(): {
  id: string;
  multiPhase: boolean;
  flowCapable: boolean;
  endpointCapable: boolean;
  correlationCapable: boolean;
}[] {
  return Object.keys(FACTORIES).map((id) => {
    const a = FACTORIES[id]();
    return {
      id,
      multiPhase: a.multiPhase,
      flowCapable: a.flowCapable,
      endpointCapable: a.endpointCapable,
      correlationCapable: a.correlationCapable,
    };
  });
}

/** Describes every agent with live availability (probes each tool). */
export async function describeAgents(): Promise<AgentInfo[]> {
  const ids = Object.keys(FACTORIES);
  return Promise.all(
    ids.map(async (id) => {
      const a = FACTORIES[id]();
      const available = await a.available().catch(() => false);
      return {
        id,
        name: a.name,
        available,
        multiPhase: a.multiPhase,
        flowCapable: a.flowCapable,
        endpointCapable: a.endpointCapable,
        correlationCapable: a.correlationCapable,
        description: a.description,
      };
    }),
  );
}
