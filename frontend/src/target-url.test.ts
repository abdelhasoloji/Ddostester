import { describe, it, expect } from 'vitest';
import { defaultTargetUrl } from './target-url.js';

describe('defaultTargetUrl', () => {
  it('defaults a bare IPv4 literal to http:// (no TLS on a raw address)', () => {
    expect(defaultTargetUrl('46.28.109.92')).toBe('http://46.28.109.92/');
    expect(defaultTargetUrl('127.0.0.1')).toBe('http://127.0.0.1/');
  });

  it('defaults a bare IPv6 literal to http://', () => {
    expect(defaultTargetUrl('2001:db8::1')).toBe('http://2001:db8::1/');
  });

  it('defaults a hostname to https://', () => {
    expect(defaultTargetUrl('bank.cz')).toBe('https://bank.cz/');
    expect(defaultTargetUrl('staging.wedos')).toBe('https://staging.wedos/');
  });

  it('leaves an already-schemed URL unchanged', () => {
    expect(defaultTargetUrl('http://46.28.109.92/api/echo.php')).toBe(
      'http://46.28.109.92/api/echo.php',
    );
    expect(defaultTargetUrl('https://bank.cz/')).toBe('https://bank.cz/');
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(defaultTargetUrl('  46.28.109.92  ')).toBe('http://46.28.109.92/');
  });
});
