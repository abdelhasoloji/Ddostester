import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount anything a test rendered, so React trees never leak across tests
// (otherwise `screen` queries can match duplicated elements from a prior test —
// an order-dependent flake).
afterEach(() => {
  cleanup();
});
