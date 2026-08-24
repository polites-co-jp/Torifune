import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // apps/web の tsconfig paths と同じ解決をテストでも行う。
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    // 結合テストは PostgreSQL を必要とする。CI では services: postgres、
    // ローカルでは compose.yaml の torifune-postgres-test を使う。
    include: ['{apps,packages}/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/e2e/**'],
    environment: 'node',
    passWithNoTests: false,
  },
});
