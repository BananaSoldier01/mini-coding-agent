import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'E2E_FAKE_LLM=1 node server.js',
    url: 'http://127.0.0.1:38212/api/config',
    timeout: 10000,
    reuseExistingServer: true,
  },
});