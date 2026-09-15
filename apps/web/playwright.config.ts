import { defineConfig, devices } from '@playwright/test';

const API_PORT = 4100;
const WEB_PORT = 3100;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ai_concierge_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/2';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    // This sandbox pre-installs Chromium at a fixed revision under
    // /opt/pw-browsers rather than the revision this Playwright version
    // would otherwise download; point at it explicitly instead.
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @ai-concierge/api exec tsx src/server.ts',
      url: `http://localhost:${API_PORT}/health`,
      cwd: '../..',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        REDIS_URL,
        API_PORT: String(API_PORT),
        API_HOST: '127.0.0.1',
        API_PUBLIC_URL: `http://localhost:${API_PORT}`,
        CORS_ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
        WEBHOOK_SIGNING_SECRET: 'e2e-test-secret-value-1234567890',
        DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001',
        OUTBOUND_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      },
    },
    {
      command: `pnpm --filter @ai-concierge/web exec next dev --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      cwd: '../..',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        INTERNAL_API_BASE_URL: `http://localhost:${API_PORT}`,
        OUTBOUND_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      },
    },
  ],
});
