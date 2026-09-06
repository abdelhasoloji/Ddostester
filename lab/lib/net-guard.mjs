import net from 'node:net';

// Hard, NON-BYPASSABLE lab-address guard.
//
// The lab must never emit UDP toward a public address — even when a component is
// run directly with `node` outside the isolated Docker network. The earlier
// guard trusted an env-overridable string prefix (`startsWith(LAB_CIDR_PREFIX)`),
// which an empty prefix defeats. This validates, by real octet math, that a
// destination is a private/loopback IPv4. It cannot be widened by configuration.

const PRIVATE_V4 = [
  { label: '10.0.0.0/8', test: (o) => o[0] === 10 },
  { label: '172.16.0.0/12', test: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31 },
  { label: '192.168.0.0/16', test: (o) => o[0] === 192 && o[1] === 168 },
  { label: '127.0.0.0/8', test: (o) => o[0] === 127 },
];

/** True only for an RFC1918 or loopback IPv4 address. */
export function isLabAddress(ip) {
  if (typeof ip !== 'string' || !net.isIPv4(ip)) return false;
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return PRIVATE_V4.some((r) => r.test(o));
}

/** Throws unless `ip` is a private/loopback IPv4 (the hard gate). */
export function assertLabAddress(ip, name = 'address') {
  if (!isLabAddress(ip)) {
    throw new Error(
      `${name} must be a private/loopback IPv4 (RFC1918 or 127/8) inside the closed lab; got ${JSON.stringify(ip)}`,
    );
  }
  return ip;
}

/**
 * Applies the hard private-range gate, then an OPTIONAL extra narrowing to a
 * specific lab prefix. The prefix can only narrow within the private range — it
 * can never widen the gate (an empty/absent prefix still leaves the hard gate).
 */
export function assertLabAddressInPrefix(ip, prefix, name = 'address') {
  assertLabAddress(ip, name);
  const p = typeof prefix === 'string' ? prefix.trim() : '';
  if (p && !ip.startsWith(p)) {
    throw new Error(`${name} ${ip} is outside the configured lab prefix ${p}`);
  }
  return ip;
}
