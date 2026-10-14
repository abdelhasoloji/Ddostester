/** Validate every destination before any transport is opened. Redirects remain disabled. */
export function assertDestination(raw: string, allowedHosts: string[]): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Destination must be HTTP(S) without embedded credentials');
  if (!allowedHosts.includes(url.hostname))
    throw new Error(`Host "${url.hostname}" is not in the allowlist`);
  return url;
}
