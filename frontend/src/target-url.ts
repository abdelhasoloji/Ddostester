/**
 * Default URL for an allowlisted host chosen from a picker.
 *
 * A bare IP literal is almost never served over TLS (there's no trusted cert for
 * a raw address), so it defaults to `http://` — otherwise selecting an HTTP-only
 * origin (e.g. the bare-origin benchmark 46.28.109.92) silently produces an
 * unreachable `https://` URL that reads as "the target is down". A hostname
 * defaults to `https://`. If the host already carries a scheme it is returned
 * unchanged. The operator can always edit the resulting URL by hand.
 */
export function defaultTargetUrl(host: string): string {
  const h = host.trim();
  if (/^https?:\/\//i.test(h)) return h;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  const isIpv6 = h.includes(':') && /^[0-9a-f:]+$/i.test(h);
  const scheme = isIpv4 || isIpv6 ? 'http' : 'https';
  return `${scheme}://${h}/`;
}
