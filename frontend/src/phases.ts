/**
 * The five-phase engagement model (offensive lifecycle, bounded). Single source
 * for the phase rail and any phase-aware UI. See docs/five-phase-model.md — the
 * execute/measure phases are BOUNDED analogues (load delivery + resilience
 * measurement), never exploitation or persistence.
 */
export interface Phase {
  n: number;
  id: 'recon' | 'plan' | 'execute' | 'measure' | 'report';
  name: string;
  route: string;
  what: string;
}

export const PHASES: Phase[] = [
  {
    n: 1,
    id: 'recon',
    name: 'Recon',
    route: '/prepare',
    what: 'Profile, surface, baseline, preflight',
  },
  {
    n: 2,
    id: 'plan',
    name: 'Plan',
    route: '/campaigns?tab=plan',
    what: 'Gap ladder, weakest link, priorities',
  },
  {
    n: 3,
    id: 'execute',
    name: 'Execute',
    route: '/campaigns',
    what: 'Bounded, governed load delivery',
  },
  {
    n: 4,
    id: 'measure',
    name: 'Measure',
    route: '/',
    what: 'WRS, collateral, detect/mitigate timing',
  },
  { n: 5, id: 'report', name: 'Report', route: '/reports', what: 'Reports, remediations, compare' },
];

/** The phase a route belongs to ('/' matches Measure exactly; others by prefix).
 *  The Campaigns workspace hosts both Plan (the `?tab=plan` tab) and Execute (its
 *  default), so the tab disambiguates when the pathname is `/campaigns`. */
export function phaseForPath(pathname: string, search = ''): Phase | undefined {
  if (pathname === '/') return PHASES.find((p) => p.id === 'measure');
  if (pathname.startsWith('/campaigns')) {
    const tab = new URLSearchParams(search).get('tab');
    return PHASES.find((p) => p.id === (tab === 'plan' ? 'plan' : 'execute'));
  }
  return PHASES.find(
    (p) => p.route !== '/' && !p.route.startsWith('/campaigns') && pathname.startsWith(p.route),
  );
}
