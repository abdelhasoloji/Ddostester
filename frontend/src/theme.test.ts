import { describe, expect, it, beforeEach, vi } from 'vitest';
import { getTheme, setTheme, applyTheme } from './theme.js';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to system when nothing is saved', () => {
    expect(getTheme()).toBe('system');
  });

  it('reads a saved valid theme', () => {
    localStorage.setItem('theme', 'dark');
    expect(getTheme()).toBe('dark');
  });

  it('ignores an invalid saved value', () => {
    localStorage.setItem('theme', 'neon');
    expect(getTheme()).toBe('system');
  });

  it('applyTheme sets data-theme for explicit themes and clears it for system', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('setTheme persists and applies', () => {
    setTheme('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(getTheme()).toBe('dark');
  });

  it('getTheme falls back to system when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(getTheme()).toBe('system');
    spy.mockRestore();
  });

  it('setTheme still applies when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    spy.mockRestore();
  });
});
