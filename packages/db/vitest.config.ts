import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All test files share one real Postgres test database (truncate + seed
    // per test) — running files in parallel workers races on those tables.
    fileParallelism: false,
  },
});
