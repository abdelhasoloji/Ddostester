/**
 * TLS policy for outbound requests toward internal lab targets.
 *
 * Preferred: set NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem — Node trusts your
 * internal CA and TLS verification stays ON (no code, works for every engine).
 *
 * Escape hatch (isolated lab only): INSECURE_TLS=true disables TLS certificate
 * verification for ALL outbound requests of this process (target AND probe, and
 * also notification/protection webhooks). Never use it outside a closed lab.
 */

/** True when the operator opted into skipping TLS verification (lab only). */
export function tlsInsecure(): boolean {
  return (process.env.INSECURE_TLS ?? '').trim().toLowerCase() === 'true';
}

/**
 * Applies the TLS policy to the process. Must be called once at startup, before
 * any TLS connection is opened. Returns whether insecure mode was enabled so
 * the caller can log/surface it. Idempotent.
 */
export function applyTlsPolicy(warn: (msg: string) => void): boolean {
  if (!tlsInsecure()) return false;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  warn(
    'INSECURE_TLS=true — TLS certificate verification is DISABLED for all outbound ' +
      'requests. Use only in an isolated lab; prefer NODE_EXTRA_CA_CERTS (internal CA) ' +
      'which keeps verification enabled.',
  );
  return true;
}
