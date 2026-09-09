import { describe, it, expect } from 'vitest';
import { classifyBindHost, decideBind } from '../src/util/bind.js';

describe('classifyBindHost', () => {
  it('recognises loopback', () => {
    for (const h of ['127.0.0.1', '127.5.5.5', 'localhost', '::1', '']) {
      expect(classifyBindHost(h)).toBe('loopback');
    }
  });
  it('recognises private (RFC1918 + link-local + ULA)', () => {
    for (const h of ['10.0.0.4', '172.16.9.9', '172.31.1.1', '192.168.1.10', '169.254.1.1']) {
      expect(classifyBindHost(h)).toBe('private');
    }
    expect(classifyBindHost('fe80::1')).toBe('private');
    expect(classifyBindHost('fd00::1')).toBe('private');
  });
  it('flags all-interfaces sentinels as "any"', () => {
    for (const h of ['0.0.0.0', '::', '*']) expect(classifyBindHost(h)).toBe('any');
  });
  it('treats a public IP or an unresolvable hostname as public (safe default)', () => {
    expect(classifyBindHost('8.8.8.8')).toBe('public');
    expect(classifyBindHost('172.32.0.1')).toBe('public'); // just outside 172.16/12
    expect(classifyBindHost('example.com')).toBe('public');
    expect(classifyBindHost('2606:4700::1111')).toBe('public');
  });
});

describe('decideBind', () => {
  it('allows loopback with no warning', () => {
    const d = decideBind('127.0.0.1', false);
    expect(d.ok).toBe(true);
    expect(d.warn).toBeUndefined();
  });
  it('allows a private bind but warns to firewall it', () => {
    const d = decideBind('10.0.0.4', false);
    expect(d.ok).toBe(true);
    expect(d.warn).toMatch(/firewall/i);
  });
  it('refuses a public / all-interfaces bind unless acknowledged', () => {
    expect(decideBind('0.0.0.0', false).ok).toBe(false);
    expect(decideBind('8.8.8.8', false).ok).toBe(false);
    const ack = decideBind('0.0.0.0', true);
    expect(ack.ok).toBe(true);
    expect(ack.warn).toMatch(/TLS/i);
  });
});
