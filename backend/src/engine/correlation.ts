import type { RequestStep } from './types.js';

/**
 * Correlation for bounded request flows: extract a value from a step's response
 * (e.g. a login token) and inject it into later steps via `{{name}}` templates.
 * This enables realistic authenticated L7 journeys — it is not an attack vector:
 * the requests stay bounded HTTP to allowlisted hosts.
 */

const TEMPLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Replaces `{{name}}` occurrences with the stored variable (empty if unset). */
export function substitute(template: string | undefined, vars: Record<string, string>): string {
  if (!template) return template ?? '';
  return template.replace(TEMPLATE_RE, (_m, name: string) => vars[name] ?? '');
}

/** True if the string references a `{{template}}` variable. */
export function usesTemplate(s: string | undefined): boolean {
  if (!s) return false;
  TEMPLATE_RE.lastIndex = 0;
  return TEMPLATE_RE.test(s);
}

/** Reads a dot-path (e.g. "data.token") out of a parsed JSON value. */
function jsonPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur == null) return undefined;
  return typeof cur === 'string' ? cur : JSON.stringify(cur);
}

export interface ExtractContext {
  body: string;
  headers: Record<string, string>;
}

/** Extracts a value from a response per the step's rule; undefined if not found. */
export function extractValue(
  from: 'json' | 'header' | 'regex',
  expr: string,
  ctx: ExtractContext,
): string | undefined {
  try {
    if (from === 'header') return ctx.headers[expr.toLowerCase()];
    if (from === 'json') return jsonPath(JSON.parse(ctx.body), expr);
    if (from === 'regex') {
      const m = new RegExp(expr).exec(ctx.body);
      if (!m) return undefined;
      return m[1] ?? m[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** True if a flow uses correlation (extraction or `{{template}}` references). */
export function flowUsesCorrelation(flow: RequestStep[] | undefined): boolean {
  if (!flow) return false;
  return flow.some(
    (s) =>
      s.extract != null ||
      usesTemplate(s.url) ||
      usesTemplate(s.body) ||
      Object.values(s.headers ?? {}).some((v) => usesTemplate(v)),
  );
}
