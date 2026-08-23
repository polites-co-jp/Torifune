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
      'no-console': ['error', { allow: ['warn', 'error'] }],
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

  prettier,
);
