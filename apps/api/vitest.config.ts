import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration/security suites share one real Postgres/Redis instance
    // (truncate + seed per test) — running files in parallel workers races
    // on those tables. Harmless for the pure-unit suite too.
    fileParallelism: false,
  },
});
