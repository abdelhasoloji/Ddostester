// Synthetic amplification profiles for the closed ShieldTest lab.
//
// These are NOT protocol implementations and they do NOT talk to any real
// DNS/NTP/SSDP/memcached service. Each profile only carries the *traffic shape*
// (a byte factor and a packet factor) that approximates a protocol's published
// amplification behaviour, so detection and mitigation can be studied against
// realistic-looking traffic. Every value is still clamped by the reflector's
// hard caps (MAX_FACTOR / MAX_RESPONSE_BYTES / MAX_PACKET_FACTOR) at runtime.
//
// `referenceBap` is the documented real-world figure (US-CERT TA14-017 and
// public memcached reports) kept for comparison only; the *effective* BAP the
// lab produces is whatever survives the caps and is what the metrics report.

export const PROFILES = {
  generic: { factor: 10, packetFactor: 1, referenceBap: 10, note: 'baseline synthetic shape' },
  dns: { factor: 40, packetFactor: 1, referenceBap: 54, note: 'DNS ANY-style response' },
  ssdp: { factor: 30, packetFactor: 1, referenceBap: 31, note: 'SSDP/UPnP discovery reply' },
  ntp: { factor: 100, packetFactor: 6, referenceBap: 557, note: 'NTP monlist-style burst' },
  memcached: { factor: 100, packetFactor: 10, referenceBap: 10000, note: 'memcached stats flood' },
};

export const DEFAULT_PROFILE = 'generic';

// Fixed allowlist of profile names. Anything else collapses to `other`, which
// bounds Prometheus label cardinality and keeps untrusted input out of the
// metrics text.
export const PROFILE_NAMES = Object.keys(PROFILES);

export function isKnownProfile(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, name);
}

// Sanitize a profile label coming off the wire before it is used as a metric
// label. Never returns anything outside PROFILE_NAMES ∪ {'other'}.
export function sanitizeProfileLabel(name) {
  return isKnownProfile(name) ? name : 'other';
}

export function resolveProfile(name) {
  return PROFILES[name] || PROFILES[DEFAULT_PROFILE];
}
