import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Entry points / thin glue with no meaningful branches to unit-test.
      exclude: ['src/server.ts', 'src/**/*.d.ts'],
      // Realistic floor today (external-tool run() paths need the binaries and
      // are integration-only); raised as unit coverage grows.
      thresholds: {
        lines: 72,
        functions: 80,
        statements: 72,
        branches: 78,
      },
    },
  },
});
