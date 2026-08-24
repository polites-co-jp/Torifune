import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 公開Plugin APIはソースのまま参照する（npm公開用のビルド設定は 010-plugin-api で整える）
  transpilePackages: ['@torifune/plugin-api'],
  // Domain 層の型崩れをビルドで止める
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
