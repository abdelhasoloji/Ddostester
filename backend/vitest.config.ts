import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // These suites are dominated by real-time WAITS (bounded run durations,
    // deadline/backstop timers, probe intervals), not CPU — so on a CI runner
    // with few cores they serialise and wall-clock balloons. Overlap far more
    // files than the core count to hide those waits behind each other. Safe:
    // there is no shared mutable state across test files (no localStorage/db;
    // each builds its own in-memory store and binds ephemeral ports).
    pool: 'forks',
    poolOptions: { forks: { minForks: 4, maxForks: 8 } },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Entry points / thin glue with no meaningful branches to unit-test
      // (the CLI orchestrates a live run against a lab target; its decision
      // logic lives in modules/campaigns/slogate.ts, which is unit-tested).
      exclude: [
        'src/server.ts',
        'src/cli/**',
        'src/**/*.d.ts',
        // Bounded network orchestration (needs a live authorized target) —
        // integration-only, like the engine run() paths; its decision logic
        // lives in modules/recon/recon.ts, which is unit-tested.
        'src/modules/recon/fetch.ts',
      ],
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
