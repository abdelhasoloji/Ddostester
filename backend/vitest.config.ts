import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Entry points / thin glue with no meaningful branches to unit-test
      // (the CLI orchestrates a live run against a lab target; its decision
      // logic lives in modules/campaigns/slogate.ts, which is unit-tested).
      exclude: ['src/server.ts', 'src/cli/**', 'src/**/*.d.ts'],
      // Floor tracking current coverage (external-tool run() paths need the
      // binaries and are integration-only); raised as unit coverage grows.
      thresholds: {
        lines: 73,
        functions: 84,
        statements: 73,
        branches: 79,
      },
    },
  },
});
