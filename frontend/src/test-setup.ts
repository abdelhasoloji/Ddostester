import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// In-memory Web Storage for tests.
//
// Node ≥22 exposes an experimental `localStorage` global ONLY when
// `--localstorage-file` is passed; without the flag it throws on access, and
// that Node global SHADOWS jsdom's own localStorage — so the app's storage
// touches used to require the flag. But the flag points every parallel vitest
// worker at ONE shared SQLite file, whose lock contention produced flaky
// "false" localStorage failures (a green suite failing at random on push/CI).
//
// Installing a plain in-memory Storage here gives every worker a real, working,
// fully isolated store with NO file, NO flag and NO contention — deterministic
// regardless of NODE_OPTIONS. Cleared between tests below for per-test isolation.
class MemoryStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.has(key) ? this.m.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.m.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(String(key), String(value));
  }
}
const memoryStores: MemoryStorage[] = [];
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const store = new MemoryStorage();
  memoryStores.push(store);
  const value = store as unknown as Storage;
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, { value, configurable: true, writable: true });
  }
}

// jsdom lacks the browser APIs uPlot (the native charts) needs: matchMedia,
// ResizeObserver and a canvas 2D context. Provide standard no-op shims so chart
// components mount in tests without pulling in the heavy `canvas` package.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof HTMLCanvasElement !== 'undefined') {
  // A Proxy 2D context: every method is a no-op, with the few accessors uPlot
  // reads returning benign values.
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'canvas') return document.createElement('canvas');
        if (prop === 'measureText') return () => ({ width: 0 });
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
          return () => ({ addColorStop() {} });
        if (prop === 'getImageData') return () => ({ data: [] });
        return () => {};
      },
    },
  );
  HTMLCanvasElement.prototype.getContext = (() =>
    ctx) as unknown as HTMLCanvasElement['getContext'];
}

// Unmount anything a test rendered, so React trees never leak across tests
// (otherwise `screen` queries can match duplicated elements from a prior test —
// an order-dependent flake).
afterEach(() => {
  cleanup();
  // Isolate storage between tests (the in-memory stores persist within a worker).
  for (const store of memoryStores) store.clear();
});
