/**
 * Bind-address safety for the control plane.
 *
 * ShieldTest is a DDoS-resilience control plane — exposing its API/UI on a
 * reachable interface without a TLS/mTLS reverse proxy is dangerous, so the
 * default bind is loopback. To let the isolated lab runner (VPS 2) reach the
 * API, an operator may bind to a PRIVATE address (and firewall it to the runner
 * only). Binding to a PUBLIC address or to all interfaces (0.0.0.0 / ::) is
 * refused unless explicitly acknowledged, so it can never happen by accident.
 */
export type BindScope = 'loopback' | 'private' | 'any' | 'public';

/** Classify a bind host by network scope (best-effort, IPv4 + common IPv6). */
export function classifyBindHost(host: string): BindScope {
  const h = host.trim().toLowerCase();
  if (h === '' || h === 'localhost') return 'loopback';
  // Bind-to-everything sentinels.
  if (h === '0.0.0.0' || h === '::' || h === '*') return 'any';

  // IPv6 (strip a zone id and brackets).
  if (h.includes(':')) {
    const v6 = h.replace(/^\[|\]$/g, '').split('%')[0];
    if (v6 === '::1') return 'loopback';
    if (v6.startsWith('fe80')) return 'private'; // link-local
    if (/^f[cd]/.test(v6)) return 'private'; // unique local fc00::/7
    return 'public';
  }

  // IPv4.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return 'public'; // a hostname we can't classify → treat as public (safe)
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'private'; // link-local
  return 'public';
}

export interface BindDecision {
  ok: boolean;
  scope: BindScope;
  /** A warning to log when binding proceeds on a non-loopback address. */
  warn?: string;
  /** The reason to refuse (ok=false). */
  error?: string;
}

/**
 * Decide whether binding to `host` is allowed. Loopback is always fine; a
 * private address is allowed with a firewall warning; a public/any bind is
 * refused unless `allowPublic` (operator set ALLOW_PUBLIC_BIND=1).
 */
export function decideBind(host: string, allowPublic: boolean): BindDecision {
  const scope = classifyBindHost(host);
  if (scope === 'loopback') return { ok: true, scope };
  if (scope === 'private') {
    return {
      ok: true,
      scope,
      warn:
        `binding to PRIVATE address ${host} — restrict it with a firewall to the ` +
        `lab runner (VPS 2) only; never expose the control plane publicly.`,
    };
  }
  // 'any' or 'public'
  if (allowPublic) {
    return {
      ok: true,
      scope,
      warn:
        `binding to ${scope === 'any' ? 'ALL interfaces' : 'PUBLIC address'} ${host} ` +
        `(ALLOW_PUBLIC_BIND=1) — you MUST front it with TLS/mTLS and a firewall.`,
    };
  }
  return {
    ok: false,
    scope,
    error:
      `Refusing to bind to ${scope === 'any' ? 'all interfaces' : 'public address'} ${host}: ` +
      `the ShieldTest control plane must not be exposed. Bind to loopback (default) or a ` +
      `PRIVATE address for the lab runner, or set ALLOW_PUBLIC_BIND=1 if you have a ` +
      `TLS/mTLS proxy and firewall in front.`,
  };
}
