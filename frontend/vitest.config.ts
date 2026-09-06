import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts', 'src/**/*.test.{ts,tsx}'],
      // Floor after the page + form + component tests (lines ~62%, branches
      // ~56%); rises as more of the UI is covered.
      thresholds: {
        lines: 55,
        functions: 30,
        statements: 55,
        branches: 50,
      },
    },
  },
});
