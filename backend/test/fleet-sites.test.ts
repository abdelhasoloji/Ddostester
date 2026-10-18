import { describe, expect, it } from 'vitest';
import { FLEET_LIMITS } from '../src/config/limits.js';
import { agentIdsOf, parseFleetSites, siteOf } from '../src/modules/fleet/sites.js';

describe('fleet site registry (M2.3)', () => {
  it('parses one agent per site', () => {
    const sites = parseFleetSites('one@vps-lab,two@vps-lab,three@ac02');
    expect(sites).toEqual([
      { agentId: 'one', site: 'vps-lab' },
      { agentId: 'two', site: 'vps-lab' },
      { agentId: 'three', site: 'ac02' },
    ]);
    expect(agentIdsOf(sites)).toEqual(['one', 'two', 'three']);
    expect(siteOf(sites, 'three')).toBe('ac02');
    expect(siteOf(sites, 'four')).toBeUndefined();
  });

  it('tolerates whitespace and empty entries', () => {
    expect(parseFleetSites(' one@lab , two@lab , ')).toEqual([
      { agentId: 'one', site: 'lab' },
      { agentId: 'two', site: 'lab' },
    ]);
  });

  it('refuses a malformed or ambiguous registry', () => {
    for (const raw of [
      '',
      ',',
      'one',
      'one@',
      '@lab',
      'one@lab@extra',
      'One@lab',
      'one@Lab',
      'one@lab,two@lab,one@ac02', // duplicate agent
      'one@lab,two@lab,three@lab,four@lab', // more agents than the envelope splits
      ' one , two ',
    ])
      expect(() => parseFleetSites(raw), raw).toThrow('Invalid fleet site registry');
  });

  it('caps the registry at the same bound the budget split uses', () => {
    const tooMany = Array.from({ length: FLEET_LIMITS.maxAgents + 1 }, (_, i) => `a${i}@lab`);
    expect(() => parseFleetSites(tooMany.join(','))).toThrow('Invalid fleet site registry');
  });
});
