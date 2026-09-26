import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration/security suites share one real Postgres/Redis instance
    // (truncate + seed per test) — running files in parallel workers races
    // on those tables. Harmless for the pure-unit suite too.
    fileParallelism: false,
    // A webhook turn now runs the whole automatic Steps 1-8 chain (dozens of queries),
    // so the 5s default is too tight for an integration test on a non-local database.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
