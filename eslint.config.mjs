// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * アーキテクチャ境界のうち、機械的に検査できるものはここで落とす。
 * 人間の注意力ではなく lint で守る（docs/仕様書/01_アーキテクチャ設計.md §15）。
 */
const DB_PACKAGES = ['pg', 'pg-pool', 'kysely', 'kysely/*'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/next-env.d.ts',
      'apps/web/src/plugin/generated-registry.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // ログは infrastructure/logging.ts の口だけを通す（07_開発者向けガイド.md §36）。
      // 直接呼ぶと出力の形式が揃わず、機密を落とす処理も通らない。
      // 出力口そのものと、コンソールを検査するテストだけが例外（下で 'off' にする）。
      'no-console': 'error',
    },
  },

  // テストはコンソール出力そのものを検査するため、直接触れてよい。
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },

  // Domain 層は特定の DB 製品に依存してはならない。
  {
    files: ['apps/web/src/domain/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: DB_PACKAGES.map((name) => ({
            name,
            message:
              'Domain 層は DB 製品に依存できない。Repository Interface を定義し、実装は infrastructure に置く。',
          })),
          patterns: [
            {
              group: ['**/infrastructure/**', '@/infrastructure/**'],
              message: 'Domain 層から Infrastructure 層へ依存してはならない（依存の向きが逆）。',
            },
            {
              group: ['**/api/**', '@/api/**', '**/ui/**', '@/ui/**'],
              message: 'Domain 層から上位レイヤへ依存してはならない。',
            },
          ],
        },
      ],
    },
  },

  // 公開 Plugin API は本体へ依存してはならない。
  {
    files: ['packages/plugin-api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@torifune/web', '@torifune/web/*', '**/apps/web/**'],
              message:
                '公開 Plugin API は本体実装へ依存してはならない。依存の向きは 本体 → plugin-api の一方向。',
            },
          ],
        },
      ],
    },
  },

  // CLI はテスト支援でのみ使う。本番コードから引くとアプリに CLI が同梱される。
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/test-support/**', 'apps/web/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@torifune/cli', '@torifune/cli/*'],
              message:
                '@torifune/cli はテスト支援専用。本番コードから参照しない（アプリに CLI が同梱される）。',
            },
          ],
        },
      ],
    },
  },

  // UI から Database へ直接触らない（docs/仕様書/06_画面設計.md §3）。
  {
    files: ['apps/web/src/ui/**/*.{ts,tsx}', 'apps/web/src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: DB_PACKAGES.map((name) => ({
            name,
            message: 'UI から Database へ直接アクセスしてはならない。Application 層を経由する。',
          })),
        },
      ],
    },
  },

  // ビルド用スクリプト。Node で直接動かすので、
  // ブラウザ前提の既定とは前提が違う。進捗の出力も要る。
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        // 検証ドライバはコンテナの中から HTTP を叩く。Node 22 の標準。
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  prettier,
);
