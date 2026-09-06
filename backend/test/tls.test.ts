import { afterEach, describe, expect, it } from 'vitest';
import { applyTlsPolicy, tlsInsecure } from '../src/util/tls.js';

const snapshot = {
  INSECURE_TLS: process.env.INSECURE_TLS,
  NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
};

afterEach(() => {
  process.env.INSECURE_TLS = snapshot.INSECURE_TLS;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = snapshot.NODE_TLS_REJECT_UNAUTHORIZED;
});

describe('tls policy', () => {
  it('defaults to secure (verification on)', () => {
    delete process.env.INSECURE_TLS;
    expect(tlsInsecure()).toBe(false);
    const warnings: string[] = [];
    expect(applyTlsPolicy((m) => warnings.push(m))).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('enables insecure mode and warns when INSECURE_TLS=true', () => {
    process.env.INSECURE_TLS = 'true';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    expect(tlsInsecure()).toBe(true);
    const warnings: string[] = [];
    expect(applyTlsPolicy((m) => warnings.push(m))).toBe(true);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');
    expect(warnings[0]).toMatch(/INSECURE_TLS/);
  });

  it('is case-insensitive and ignores other values', () => {
    process.env.INSECURE_TLS = 'TRUE';
    expect(tlsInsecure()).toBe(true);
    process.env.INSECURE_TLS = 'yes';
    expect(tlsInsecure()).toBe(false);
  });
});
