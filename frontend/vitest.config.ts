import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // uPlot draws to a real canvas; under jsdom its spline renderer throws
    // unhandled errors. Alias the bare `uplot` import (not its CSS subpath) to a
    // no-op stub so chart components mount in tests. Production uses real uPlot.
    alias: [
      {
        find: /^uplot$/,
        replacement: fileURLToPath(new URL('./src/test/uplot-stub.ts', import.meta.url)),
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts', 'src/**/*.test.{ts,tsx}'],
      // Floor after page/form/component + api/context/theme/App/Login/settings
      // interaction tests (lines ~84%, branches ~70%, functions ~62%); rises as
      // more of the UI is covered.
      thresholds: {
        lines: 80,
        functions: 58,
        statements: 80,
        branches: 66,
      },
    },
  },
});
