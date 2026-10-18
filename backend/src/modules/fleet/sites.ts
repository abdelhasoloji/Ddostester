import { FLEET_LIMITS } from '../../config/limits.js';

export interface FleetSite {
  /** Certificate CN of the agent. */
  agentId: string;
  /** Physical/logical site that emits this agent's traffic. */
  site: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The operator-owned site registry, e.g. `one@vps-lab,two@vps-lab,three@ac02`.
 *
 * The agent identity remains the certificate CN, so revocation and assignment
 * checks are unchanged; the site is the label that says where that identity runs.
 * One entry per agent, no duplicates, and never more agents than the fleet
 * envelope can split a budget across (`FLEET_LIMITS.maxAgents`) — a registry can
 * therefore never describe more execution slots than the aggregate allows.
 */
export function parseFleetSites(raw: string): FleetSite[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length < 1 || entries.length > FLEET_LIMITS.maxAgents)
    throw new Error('Invalid fleet site registry');
  const sites = entries.map((entry) => {
    const parts = entry.split('@');
    if (parts.length !== 2) throw new Error('Invalid fleet site registry');
    const [agentId, site] = parts;
    if (!ID.test(agentId) || !ID.test(site)) throw new Error('Invalid fleet site registry');
    return { agentId, site };
  });
  if (new Set(sites.map((entry) => entry.agentId)).size !== sites.length)
    throw new Error('Invalid fleet site registry');
  return sites;
}

export function agentIdsOf(sites: readonly FleetSite[]): string[] {
  return sites.map((entry) => entry.agentId);
}

export function siteOf(sites: readonly FleetSite[], agentId: string): string | undefined {
  return sites.find((entry) => entry.agentId === agentId)?.site;
}

/**
 * The agents THIS cluster must start jobs for: those whose registry site matches
 * the local site. A remote site's agents are dispatched by its own resident
 * worker, so creating a local job for them would race the remote claim — and
 * because `claim` is atomic, whichever loses silently gets no work. Returning an
 * empty list is legitimate (a control plane whose agents all live elsewhere).
 */
export function localAgents(sites: readonly FleetSite[], localSite: string): FleetSite[] {
  if (!ID.test(localSite)) throw new Error('Invalid local site');
  return sites.filter((entry) => entry.site === localSite);
}
