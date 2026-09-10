import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no matchMedia; uPlot (imported by the native charts) calls it at
// module load. Provide the standard no-op shim so importing chart code doesn't
// throw in tests.
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

// Unmount anything a test rendered, so React trees never leak across tests
// (otherwise `screen` queries can match duplicated elements from a prior test —
// an order-dependent flake).
afterEach(() => {
  cleanup();
});
