/**
 * Edge-served error-page detection (defensive, passive). When a protected target
 * is pushed hard enough, its edge (WEDOS.protection, a CDN, a rate-limiter) stops
 * proxying to the origin and serves its OWN error page instead — a 502 "origin
 * server returned an invalid response", a 429 rate-limit page, or a challenge/
 * block page. That page is a strong, first-party signal:
 *   - it tells us the EDGE is healthy but the ORIGIN buckled (a real impact),
 *   - it identifies the vendor and the defense LAYER that engaged, and
 *   - it often LEAKS diagnostics (node, request id, backend server, even the
 *     origin IP) — an information-disclosure finding in its own right.
 *
 * We only CAPTURE and REPORT this; the leaked origin IP is never turned into a
 * target (that would bypass the edge and the allowlist). The parser is pure so
 * it is unit-tested against real captured pages.
 */
export interface EdgeErrorSignal {
  /** HTTP status the edge served (e.g. 502/503/504/429). */
  status: number;
  /**
   * Which layer the edge blamed:
   *  - 'origin'     — backend errored / was overwhelmed (5xx origin page),
   *  - 'rate-limit' — the edge rate-limited us (429),
   *  - 'challenge'  — a bot/JS/CAPTCHA or access-denied block page,
   *  - 'edge'       — a generic edge-served error page.
   */
  layer: 'origin' | 'rate-limit' | 'challenge' | 'edge';
  /** The protection vendor the page identifies as, when stated (e.g. 'WEDOS'). */
  vendor?: string;
  /** Edge node / PoP the page names. */
  node?: string;
  /** The edge's request/trace id (support correlation). */
  reqId?: string;
  /** Backend/upstream server name the page leaks. */
  server?: string;
  /** Transport the page reports (e.g. 'HTTPS (H3) (443)'). */
  protocol?: string;
  /**
   * Origin IP leaked by the error page. Captured as an INFORMATION-DISCLOSURE
   * finding only — the control plane never targets it (that would bypass the
   * edge and the allowlist).
   */
  originIpLeaked?: string;
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/** Extract a `Label: value` field from an error page's diagnostic block. */
function field(body: string, label: string): string | undefined {
  const m = body.match(new RegExp(`${label}\\s*[:=]\\s*([^\\n<\\r]+)`, 'i'));
  if (!m) return undefined;
  const v = m[1].trim();
  return v || undefined;
}

/** Normalize a matched vendor string ('WEDOS.protection', 'wedos protection') → 'WEDOS'. */
function normalizeVendor(raw: string): string {
  if (/wedos/i.test(raw)) return 'WEDOS';
  if (/cloudflare/i.test(raw)) return 'Cloudflare';
  if (/akamai/i.test(raw)) return 'Akamai';
  if (/sucuri/i.test(raw)) return 'Sucuri';
  return raw.trim();
}

/**
 * Classify a response as an edge-served error page, or return null when it is a
 * plain origin response (or not an error). `status` is the HTTP status; `body`
 * is the (bounded) response text.
 */
export function detectEdgeError(status: number, body: string): EdgeErrorSignal | null {
  if (!Number.isFinite(status) || status < 400) return null;
  const text = (body ?? '').slice(0, 20000);
  const vendorMatch =
    text.match(/wedos[.\s-]*protection/i) ||
    text.match(/\b(cloudflare|akamai|sucuri)\b/i) ||
    text.match(/protected by\s+([A-Za-z][\w.-]*)/i);
  const mentionsOrigin = /origin server|serveur d'origine|upstream/i.test(text);
  const looksEdgePage =
    !!vendorMatch || mentionsOrigin || /error id|request id|req[-\s]?id/i.test(text);

  let layer: EdgeErrorSignal['layer'];
  if (status === 429) {
    layer = 'rate-limit';
  } else if (status >= 500 && (mentionsOrigin || looksEdgePage)) {
    layer = 'origin';
  } else if (
    /captcha|challenge|are you (a )?human|access denied|forbidden by|blocked/i.test(text)
  ) {
    layer = 'challenge';
  } else if (looksEdgePage) {
    layer = 'edge';
  } else {
    // A plain origin 4xx/5xx with no edge-page signature — not our signal.
    return null;
  }

  // The origin IP is often on an "IP:" line; fall back to the first bare IPv4.
  const ipLine = text.match(/\b(?:origin\s+ip|ip)\b\s*[:=]\s*((?:\d{1,3}\.){3}\d{1,3})/i);
  const ip = ipLine ? ipLine[1] : text.match(IPV4)?.[0];

  return {
    status,
    layer,
    vendor: vendorMatch ? normalizeVendor(vendorMatch[1] ?? vendorMatch[0]) : undefined,
    node: field(text, 'Node'),
    reqId: field(text, 'Req[-\\s]?ID') ?? field(text, 'Request ID') ?? field(text, 'Error ID'),
    server: field(text, 'Server'),
    protocol: field(text, 'Protocol'),
    originIpLeaked: ip,
  };
}

/** A one-line, operator-facing summary of an edge-error signal. */
export function describeEdgeError(e: EdgeErrorSignal): string {
  const who = e.vendor ? `${e.vendor} ` : '';
  switch (e.layer) {
    case 'origin':
      return `${who}served its origin-error page (HTTP ${e.status}) — the edge held but the ORIGIN buckled under load.`;
    case 'rate-limit':
      return `${who}rate-limited the load (HTTP ${e.status}).`;
    case 'challenge':
      return `${who}served a challenge / block page (HTTP ${e.status}).`;
    default:
      return `${who}served an edge error page (HTTP ${e.status}).`;
  }
}
