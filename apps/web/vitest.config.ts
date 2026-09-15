import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // e2e/**/*.spec.ts are Playwright specs, run via `pnpm test:e2e`, not vitest.
    exclude: ['**/node_modules/**', '**/e2e/**', '**/.next/**'],
  },
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, 'src/test/server-only-stub.ts'),
    },
  },
});
