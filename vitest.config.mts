import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // apps/web の tsconfig paths と同じ解決をテストでも行う。
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  // apps/web の tsconfig は Next.js 向けに `jsx: preserve` なので、そのままでは
  // テストから `.tsx` の部品を読めない。UI 部品の単体テスト
  // （`react-dom/server` の `renderToStaticMarkup` で静的 HTML を検査する。
  // 028 実装プラン §2）のために、テスト時だけ JSX を変換する。
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // 結合テストは PostgreSQL を必要とする。CI では services: postgres、
    // ローカルでは compose.yaml の torifune-postgres-test を使う。
    include: ['{apps,packages}/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/e2e/**'],
    environment: 'node',
    passWithNoTests: false,
  },
});
