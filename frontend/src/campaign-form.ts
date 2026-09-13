import type { RequestStep, WeightedEndpoint } from './api.js';

/**
 * Pure parsers/builders for the new-campaign form editors (feeder, endpoint mix,
 * flow, SLO, assertion, scenario). Kept out of the React tree so they can be
 * unit-tested in isolation and reused. No I/O; nothing here bypasses a safeguard
 * — the server re-validates every field against the allowlist and caps.
 */

/** Default state of the new-campaign form. */
export const emptyForm = {
  name: '',
  target: 'http://127.0.0.1:8080/health',
  probeUrl: 'http://127.0.0.1:8080/health',
  referenceUrl: '',
  vector: 'http-get',
  maxRps: 20,
  concurrency: 5,
  maxDurationSec: 30,
  scheduledAt: '',
  recurrenceMin: '',
  profile: 'constant',
  agent: '',
  body: '',
  flow: '',
  flowAdvanced: false,
  sloP95: '',
  sloErr: '',
  sloAvail: '',
  sloWrs: '',
  sloAssert: '',
  assertStatus: '',
  assertBody: '',
  endpoints: '',
  userAgents: '',
  dataset: '',
  cacheBust: false,
};

/** Parses the feeder editor (CSV: header line, then rows) into dataset rows. */
export function parseDataset(raw: string): Record<string, string>[] | undefined {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return undefined;
  const cols = lines[0].split(',').map((c) => c.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    cols.forEach((c, i) => {
      row[c] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

/** Parses the endpoint-mix editor: one per line, "[METHOD] url [weight]". */
export function parseEndpoints(raw: string): WeightedEndpoint[] | undefined {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
  return lines.map((line) => {
    const parts = line.split(/\s+/);
    let method: string | undefined;
    if (methods.has(parts[0]?.toUpperCase())) method = parts.shift()!.toUpperCase();
    let weight: number | undefined;
    if (parts.length > 1 && /^\d+(\.\d+)?$/.test(parts[parts.length - 1])) {
      weight = Number(parts.pop());
    }
    return { method, url: parts.join(' '), weight };
  });
}

/** Builds the acceptance criteria from the (optional) SLO form fields. */
export function buildAcceptance(f: {
  sloP95: string;
  sloErr: string;
  sloAvail: string;
  sloWrs: string;
  sloAssert: string;
}): Record<string, number> | undefined {
  const a: Record<string, number> = {};
  if (f.sloP95) a.maxP95Ms = Number(f.sloP95);
  if (f.sloErr) a.maxErrorRatePct = Number(f.sloErr);
  if (f.sloAvail) a.minAvailabilityPct = Number(f.sloAvail);
  if (f.sloWrs) a.minWrs = Number(f.sloWrs);
  if (f.sloAssert) a.maxAssertionFailurePct = Number(f.sloAssert);
  return Object.keys(a).length ? a : undefined;
}

/** Builds the per-response assertion (built-in engine only) from form fields. */
export function buildAssertion(f: {
  assertStatus: string;
  assertBody: string;
}): Record<string, unknown> | undefined {
  const a: Record<string, unknown> = {};
  if (f.assertStatus) a.status = Number(f.assertStatus);
  if (f.assertBody.trim()) a.bodyContains = f.assertBody.trim();
  return Object.keys(a).length ? a : undefined;
}

/** Parses the advanced flow editor (raw JSON RequestStep[]). Throws on error. */
export function parseFlowJson(raw: string): RequestStep[] | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const parsed = JSON.parse(t);
  if (!Array.isArray(parsed)) throw new Error('Flow (JSON) must be an array of steps.');
  return parsed as RequestStep[];
}

/**
 * Parses a flow editor (one step per line: "METHOD /path [thinkMs]") into
 * bounded RequestStep[]. Each step keeps the target's host, so it stays within
 * the allowlist. Returns undefined when empty.
 */
export function parseFlow(raw: string, origin: string): RequestStep[] | undefined {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines.map((line) => {
    const tokens = line.split(/\s+/);
    const method = (tokens[0] || 'GET').toUpperCase();
    let pathTokens = tokens.slice(1);
    // A trailing all-digits token is the think-time; anything else stays part of
    // the path (so "GET /my page" keeps its space instead of dropping " page").
    let thinkMs: number | undefined;
    const last = pathTokens[pathTokens.length - 1];
    if (pathTokens.length > 1 && last !== undefined && /^\d+$/.test(last)) {
      thinkMs = Number(last);
      pathTokens = pathTokens.slice(0, -1);
    }
    const p = pathTokens.join(' ');
    let url = origin;
    try {
      url = new URL(p || '/', origin).href;
    } catch {
      /* keep origin */
    }
    return { method, url, thinkMs: Number.isFinite(thinkMs) ? thinkMs : undefined };
  });
}

/** Hostname of a URL, or null when it can't be parsed. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Human-readable recurrence interval ("2 h" / "30 min"). */
export function formatInterval(min: number): string {
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}

/** Local date-time for display, or '—' when absent/unparseable. */
export function fmtDateTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Builds a ramp/wave scenario (phases) from a profile, or undefined for constant. */
export function buildScenario(profile: string, maxRps: number, durationSec: number) {
  const third = Math.max(1, Math.round(durationSec / 3));
  const pct = (p: number) => Math.max(1, Math.round((maxRps * p) / 100));
  if (profile === 'ramp')
    return [
      { maxRps: pct(25), durationSec: third },
      { maxRps: pct(50), durationSec: third },
      { maxRps: pct(100), durationSec: third },
    ];
  if (profile === 'wave')
    return [
      { maxRps: pct(100), durationSec: third },
      { maxRps: pct(20), durationSec: third },
      { maxRps: pct(100), durationSec: third },
    ];
  return undefined;
}
