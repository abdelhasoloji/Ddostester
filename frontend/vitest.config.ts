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
