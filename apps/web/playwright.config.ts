import { defineConfig } from '@playwright/test';

const PORT = Number(process.env['PORT'] ?? 3000);
const BASE_URL = process.env['TORIFUNE_E2E_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // E2E はセッションと管理者という共有状態を扱うため、直列で実行する。
  // 並列にすると、あるテストのログアウトが別のテストの前提を壊す。
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: process.env['TORIFUNE_E2E_BASE_URL']
    ? undefined
    : {
        command: 'pnpm build && pnpm start',
        url: BASE_URL,
        reuseExistingServer: !process.env['CI'],
        timeout: 180_000,
      },
});
