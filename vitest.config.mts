import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 結合テストは PostgreSQL を必要とする。CI では services: postgres、
    // ローカルでは compose.yaml の torifune-postgres-test を使う。
    include: ['{apps,packages}/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/e2e/**'],
    environment: 'node',
    passWithNoTests: false,
  },
});
