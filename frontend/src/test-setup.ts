import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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
});
