/**
 * assistant-zones — maps a screen point to a short, human explanation of the UI
 * "zone" under it, so the floating mascot can describe whatever it is dropped on.
 *
 * Pure and dependency-free. Detection samples the page BEHIND the floating
 * window: it walks the elements at the point (via elementsFromPoint) and skips
 * anything inside the mascot's own `[data-assistant-float]` container, then
 * matches the first page element against a curated selector map. When nothing
 * specific matches it falls back to a description of the current route, so the
 * mascot always has something meaningful to say. jsdom-safe: if the point APIs
 * are unavailable it returns the route description.
 */
export interface ZoneInfo {
  key: string;
  title: string;
  text: string;
}

// Most specific first — the first `closest()` hit wins.
const SELECTOR_ZONES: { sel: string; title: string; text: string }[] = [
  {
    sel: '.assistant-input,[class*="assistant"]',
    title: 'The assistant',
    text: "That's my own panel — the message box, history and governed action cards. Drag me onto the app to have me explain a zone.",
  },
  {
    sel: '.ct-suite-report',
    title: 'Report & Compare',
    text: "Open a suite's resilience report, or compare two runs — before vs. after mitigation.",
  },
  {
    sel: '.campaign-table',
    title: 'Campaigns & suites',
    text: 'Each row is a governed load campaign — its target, caps and WRS verdict. Expand a row for its steps, or open its report.',
  },
  {
    sel: '[class*="wrs"]',
    title: 'WEDOS Resilience Score',
    text: 'The graded verdict (A–F) of how well the target withstood the bounded, authorized test.',
  },
  {
    sel: '.alert-row-btn,[class*="alert"]',
    title: 'Active alerts',
    text: 'Anomalies detected on live runs, severity-coded (critical / warning / info). Click one for its context.',
  },
  {
    sel: '.kpi-link,[class*="kpi"]',
    title: 'Live KPI',
    text: 'A headline metric of the fleet — click it through to its detail: theater or the alerts list.',
  },
  {
    sel: '[class*="zone"]',
    title: 'Protected zone',
    text: 'A guarded origin behind the WEDOS edge — its edge-absorbed % is how much traffic the edge soaks up before the origin.',
  },
  {
    sel: 'nav,[class*="spine"],[class*="sidebar"]',
    title: 'Navigation',
    text: 'The spine — Command Center, Protected zones, Campaigns, Run Theater, Assistant and Settings.',
  },
];

const ROUTE_ZONES: Record<string, { title: string; text: string }> = {
  '/': {
    title: 'Command Center',
    text: 'The fleet overview — aggregate resilience, runs in flight, generator health and live alerts.',
  },
  '/zones': {
    title: 'Protected zones',
    text: 'The origins under WEDOS edge protection, and how much traffic the edge absorbs for each.',
  },
  '/campaigns': {
    title: 'Campaigns',
    text: 'Compose and launch bounded, governed resilience tests — Launch, Templates and Plan.',
  },
  '/theater': {
    title: 'Run Theater',
    text: 'The live view of an in-flight run — generator counts, latency and the resilience graph.',
  },
  '/assistant': {
    title: 'Assistant',
    text: "That's me — ask about platform state, resilience or code security, and I propose governed next actions.",
  },
  '/settings': {
    title: 'Settings',
    text: 'Operational caps, users and the audit log.',
  },
  '/account': { title: 'Account', text: 'Your profile and session.' },
};

export function routeZone(path: string): ZoneInfo {
  const keys = Object.keys(ROUTE_ZONES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k === '/' ? path === '/' : path.startsWith(k)) {
      return { key: 'route:' + k, ...ROUTE_ZONES[k] };
    }
  }
  return {
    key: 'route:unknown',
    title: 'WEDOS ShieldTest',
    text: 'Drag me over a panel and I’ll explain it.',
  };
}

/**
 * Describe the UI zone at screen point (x, y). Skips the mascot's own floating
 * window so it reads what is *behind* it. Falls back to the route description.
 */
export function describeZoneAt(
  x: number,
  y: number,
  path: string = typeof location !== 'undefined' ? location.pathname : '/',
): ZoneInfo {
  let el: Element | null = null;
  try {
    const stack: Element[] =
      typeof document !== 'undefined' && typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(x, y)
        : typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
          ? [document.elementFromPoint(x, y)].filter((e): e is Element => e != null)
          : [];
    el = stack.find((e) => e && !e.closest('[data-assistant-float]')) ?? null;
  } catch {
    el = null;
  }
  if (el) {
    for (const z of SELECTOR_ZONES) {
      if (el.closest(z.sel)) return { key: 'sel:' + z.sel, title: z.title, text: z.text };
    }
  }
  return routeZone(path);
}
