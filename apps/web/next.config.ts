import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 公開Plugin APIはソースのまま参照する（npm公開用のビルド設定は 010-plugin-api で整える）
  transpilePackages: ['@torifune/plugin-api'],
  // Domain 層の型崩れをビルドで止める。
  // ただし本番のビルド（コンテナ内の再ビルドを含む）はテストファイルを型検査しない。
  // テストは同梱 Plugin のソースを直接 import するので、そのフォルダが無いと再ビルドが落ちる。
  // テストの型は `pnpm typecheck`（tsconfig.json）が見る。詳細: docs/設計/052-rebuild-without-tests/設計.md
  typescript: { ignoreBuildErrors: false, tsconfigPath: 'tsconfig.build.json' },
};

export default nextConfig;
